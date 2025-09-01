# Balance

A super simple tray application for ensuring your time spent between two missions is equally balanced. Time is tracked using a Pomodoro-style timer.

I created this app because I found myself spending too much time on work while my artistic skills withered, and wanted a way to hold myself accountable to splitting time between work and art 50/50; my two missions in life. I also couldn't find a Pomodoro solution I really liked, so I made Pomodoro timer the mechanism for tracking time.

## ✨ Features

### 🎯 Dual Mission Tracking
- Track time between two customizable missions
- Visual balance indicator showing hours out of balance
- Lives in the system tray/menu bar

### ⏱️ Pomodoro Timer
- Customizable work sessions (default: 28 minutes)
- Break timer support (default: 3 minutes)  
- Visual countdown with progress pie chart in system tray
- Audio notification when timer ends
- Quick time extensions with keyboard modifiers

### ⚙️ Customization
- Rename missions to match your workflow
- Adjust work and break durations
- Configure acceptable balance range
- Custom data directory
- Keyboard shortcuts (press 'o' for options)

## 🚀 Installation

### Prerequisites
- Node.js (v16 or higher)
- pnpm

### Quick Start

1. **Clone the repository**

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Run in development mode**
   ```bash
   pnpm run dev
   ```

4. **Build for production**
   ```bash
   pnpm run build
   ```

## 🎮 Usage

### Basic Operations

- **Start Work Timer**: Click "Start 🍅" to begin a work session
- **Take a Break**: Click "Break 🌿" to start a break timer
- **Stop Timer**: Click "Stop ⏹️" to halt the current session
- **Switch Missions**: Click on mission tabs to change active mission

### Time Extensions

Use the `+ ⏱️` and `- ⏱️` buttons with modifiers:
- **Normal click**: ±1 minute
- **Shift + click**: ±20 seconds
- **Cmd/Ctrl + click**: ±5 minutes

### Configuration

Press `o` or click the ⚙️ button to access settings:
- Customize mission names
- Set work/break durations
- Adjust acceptable balance range
- Change data storage location

### Data Management

- Data automatically saves to your system's app data directory
- Click "📁 Open Data Folder" to access your balance history
- Data persists across app restarts

## 🏗️ Technical Details

### Built With
- **Electron** - Cross-platform desktop framework
- **Svelte** - Reactive frontend framework
- **Vite** - Fast build tool and dev server
- **Node.js** - Backend runtime

## 📊 Data Storage

Balance stores your data in a JSON file:
- **macOS**: `~/Library/Application Support/balance/balance.json`
- **Windows**: `%APPDATA%/balance/balance.json`
- **Linux**: `~/.config/balance/balance.json`

The data includes:
- Mission totals and current session
- Timer state and settings
- User preferences

## 🔧 Development

### Development Scripts
```bash
pnpm run dev          # Start dev server + electron
pnpm run dev:renderer # Frontend only
pnpm run dev:electron # Electron only (requires frontend)
pnpm run build        # Build for production
```

### Key Development Notes
- Hot reload enabled in development
- Vite handles frontend bundling
- Electron main process manages system integration
- Cross-platform compatibility built-in

## 🎨 Customization

### Themes
The app uses CSS custom properties for easy theming:
```css
--bg: #fff8e7      /* Background */
--card: #fff1cf    /* Card background */
--stroke: #2e2a24  /* Border color */
--accent: #ffb74d  /* Accent color */
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request
