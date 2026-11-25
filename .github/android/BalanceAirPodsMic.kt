package app.balance.local

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Base64
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * Reads AAC-ELD from the AirPods over classic L2CAP while Android keeps A2DP
 * playback. Wire format reference: LibrePods android/rewrite (2e244d3),
 * AACPManager, MicrophoneFrame and EldDecoder.
 */
@SuppressLint("MissingPermission")
internal class BalanceAirPodsMic(private val context: Context) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val bluetooth = context.getSystemService(BluetoothManager::class.java)
    private var capture: Capture? = null

    private fun outputs() = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .filter { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP }

    private fun deviceForOutput(adapter: BluetoothAdapter): BluetoothDevice? {
        val devices = adapter.bondedDevices
        val connected = outputs()
        return devices.firstOrNull { device ->
            val name = device.name.orEmpty()
            connected.any { output ->
                val matches = if (Build.VERSION.SDK_INT >= 28 && output.address.isNotEmpty()) {
                    output.address.equals(device.address, ignoreCase = true)
                } else {
                    output.productName.toString() == name && name.isNotEmpty()
                }
                matches && (isAirPodsName(output.productName) || isAirPodsName(name) ||
                    device.uuids?.any { it == AACP_UUID } == true)
            }
        }
    }

    fun available(): Boolean = runCatching {
        // The system's route name also lets us report a fallback if Bluetooth
        // permission was denied and we cannot query the paired device.
        outputs().any { isAirPodsName(it.productName) } ||
            bluetooth?.adapter?.let(::deviceForOutput) != null
    }.getOrDefault(false)

    @Synchronized
    fun start(): Boolean {
        stop()
        if (Build.VERSION.SDK_INT < 29 || !micAllowed()) return false
        val adapter = bluetooth?.adapter ?: return false
        val device = runCatching { deviceForOutput(adapter) }.getOrNull() ?: return false
        val current = Capture()
        capture = current
        Thread({ record(adapter, device, current) }, "Balance AirPods mic").start()
        return true
    }

    @Synchronized
    fun read(): String? {
        val current = capture ?: return null
        if (!micAllowed()) {
            stop()
            return null
        }
        if (Build.VERSION.SDK_INT >= 29 && current.isSilenced()) {
            stop()
            return null
        }
        return current.read()
    }

    @Synchronized
    fun stop() {
        capture?.close()
        capture = null
    }

    private fun micAllowed() = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED && !audio.isMicrophoneMute

    @RequiresApi(29)
    private fun record(adapter: BluetoothAdapter, device: BluetoothDevice, current: Capture) {
        try {
            val socket = createSocket(adapter, device)
            if (!current.attach(socket)) {
                socket.close()
                return
            }
            socket.connect()
            val handset = audio.getDevices(AudioManager.GET_DEVICES_INPUTS)
                .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC } ?: return
            val guard = AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16_000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .build()
            var attached = false
            try {
                // Keep Android's microphone indicator and capture policy active.
                // The handset samples are never read. Only AirPods PCM is saved.
                check(guard.setPreferredDevice(handset))
                guard.startRecording()
                // The route and recording configuration can arrive asynchronously.
                val deadline = SystemClock.elapsedRealtime() + 500
                while (guard.activeRecordingConfiguration == null && !current.closed && SystemClock.elapsedRealtime() < deadline) {
                    Thread.sleep(50)
                }
                check(guard.activeRecordingConfiguration?.isClientSilenced == false)
                check(guard.routedDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_MIC)
                attached = current.attachGuard(guard)
                if (attached) readMicrophone(socket, current)
            } finally {
                if (!attached) guard.release()
            }
        } catch (_: Exception) {
            // Android can block classic L2CAP, or the buds/codec can reject the
            // stream. The recorder handles either case as phone fallback.
        } finally {
            current.close()
        }
    }

    @RequiresApi(29)
    private fun readMicrophone(socket: BluetoothSocket, current: Capture) {
        val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        try {
            codec.configure(MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 64_000, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectELD)
                setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0xf8.toByte(), 0xe6.toByte(), 0x30, 0x00)))
            }, null, null, 0)
            codec.start()

            val output = socket.outputStream
            output.write(message(0x01, byteArrayOf(0x03) + ByteArray(9), type = 0))
            Thread.sleep(200)
            output.write(message(0x4d, byteArrayOf(0xd7.toByte()) + ByteArray(7)))
            Thread.sleep(200)
            output.write(message(0x58, MIC_START))

            val packet = ByteArray(socket.maxReceivePacketSize.coerceAtLeast(1024))
            val input = socket.inputStream
            val info = MediaCodec.BufferInfo()
            var sampleRate = 64_000
            var timeUs = 0L
            while (!current.closed && micAllowed() && !current.isSilenced()) {
                val size = input.read(packet)
                if (size < 0) break
                if (current.isSilenced()) break
                if (size < 22 || packet[4] != 0x58.toByte() || packet[6] != 1.toByte() || packet[7] != 0.toByte()) continue
                var offset = 22
                while (offset + 5 <= size) {
                    val length = packet[offset + 4].toInt() and 0xff
                    val start = offset + 5
                    if (length == 0 || start + length > size) break
                    val slot = codec.dequeueInputBuffer(10_000)
                    if (slot >= 0) {
                        val buffer = checkNotNull(codec.getInputBuffer(slot))
                        buffer.clear()
                        buffer.put(packet, start, length)
                        codec.queueInputBuffer(slot, 0, length, timeUs, 0)
                        timeUs += 7_500 // 480 samples at 64 kHz
                    }
                    offset = start + length
                    while (true) {
                        val decoded = codec.dequeueOutputBuffer(info, 0)
                        if (decoded == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            val format = codec.outputFormat
                            check(format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) == 1)
                            sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                            continue
                        }
                        if (decoded < 0) break
                        if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            val pcm = ByteArray(info.size)
                            checkNotNull(codec.getOutputBuffer(decoded)).apply {
                                position(info.offset)
                                get(pcm)
                            }
                            current.append(pcm, sampleRate)
                        }
                        codec.releaseOutputBuffer(decoded, false)
                    }
                }
            }
        } finally {
            codec.release()
        }
    }

    private class Capture {
        @Volatile var closed = false
            private set
        private var socket: BluetoothSocket? = null
        private var guard: AudioRecord? = null
        private val pcm = ByteArrayOutputStream()
        private var rate = 0

        @Synchronized
        fun attach(value: BluetoothSocket): Boolean {
            if (closed) return false
            socket = value
            return true
        }

        @Synchronized
        fun attachGuard(value: AudioRecord): Boolean {
            if (closed) return false
            guard = value
            return true
        }

        @RequiresApi(29)
        @Synchronized
        fun isSilenced(): Boolean {
            val monitor = guard ?: return false
            return monitor.activeRecordingConfiguration?.isClientSilenced != false ||
                monitor.routedDevice?.type != AudioDeviceInfo.TYPE_BUILTIN_MIC
        }

        @Synchronized
        fun append(bytes: ByteArray, sampleRate: Int) {
            if (closed) return
            // Bound the queue if the WebView is paused or busy.
            if (rate != sampleRate || pcm.size() >= sampleRate * 2) pcm.reset()
            rate = sampleRate
            pcm.write(bytes)
        }

        @Synchronized
        fun read(): String? {
            if (pcm.size() == 0) return if (closed) null else ""
            val data = Base64.encodeToString(pcm.toByteArray(), Base64.NO_WRAP)
            pcm.reset()
            return "$rate:$data"
        }

        fun close() {
            val (oldSocket, oldGuard) = synchronized(this) {
                closed = true
                (socket to guard).also {
                    socket = null
                    guard = null
                }
            }
            runCatching { oldGuard?.release() }
            runCatching { oldSocket?.close() }
        }
    }

    private companion object {
        val AACP_UUID: ParcelUuid = ParcelUuid.fromString("74ec2172-0bad-4d01-8f77-997b2be0722a")
        val MIC_START = byteArrayOf(0, 0, 9, 0, 0, 1, 0x82.toByte(), 0, 0, 0, 4, 0x96.toByte(), 0)

        fun isAirPodsName(name: CharSequence) = name.contains("AirPods", ignoreCase = true)

        fun message(opcode: Byte, body: ByteArray, type: Byte = 4) =
            byteArrayOf(type, 0, 4, 0, opcode, 0) + body

        // Android's public L2CAP client API opens LE channels. AACP uses
        // classic L2CAP, whose socket constructor varies by platform release.
        fun createSocket(adapter: BluetoothAdapter, device: BluetoothDevice): BluetoothSocket {
            val int = Int::class.javaPrimitiveType!!
            val bool = Boolean::class.javaPrimitiveType!!
            val peer = BluetoothDevice::class.java
            val uuid = ParcelUuid::class.java
            val candidates = listOf(
                arrayOf(BluetoothAdapter::class.java, peer, int, bool, bool, int, uuid) to
                    arrayOf(adapter, device, 3, true, true, 4097, AACP_UUID),
                arrayOf(peer, int, bool, bool, int, uuid) to
                    arrayOf(device, 3, true, true, 4097, AACP_UUID),
                arrayOf(peer, int, int, bool, bool, int, uuid) to
                    arrayOf(device, 3, -1, true, true, 4097, AACP_UUID),
                arrayOf(int, int, bool, bool, peer, int, uuid) to
                    arrayOf(3, -1, true, true, device, 4097, AACP_UUID),
                arrayOf(int, bool, bool, peer, int, uuid) to
                    arrayOf(3, true, true, device, 4097, AACP_UUID),
            )
            for ((signature, arguments) in candidates) {
                try {
                    return BluetoothSocket::class.java.getDeclaredConstructor(*signature).apply {
                        isAccessible = true
                    }.newInstance(*arguments)
                } catch (_: ReflectiveOperationException) {
                    // Try the next platform signature.
                }
            }
            error("Classic L2CAP unavailable")
        }
    }
}
