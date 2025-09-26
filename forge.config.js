module.exports = {
    packagerConfig: {
        asar: true,
        icon: undefined, // Add an icon path if you have one
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin'],
        },
        {
            name: '@electron-forge/maker-dmg',
            config: {
                format: 'ULFO',
            },
        },
    ],
};
