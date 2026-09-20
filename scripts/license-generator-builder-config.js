const path = require('path');

module.exports = {
  appId: 'com.gsrd.gsbot.license-generator',
  productName: 'GS Bot License Generator',
  directories: {
    output: path.join('release', 'license-generator'),
  },
  files: [
    'license-generator-app/**/*',
    'license-generator-core.js',
  ],
  extraResources: [],
  asar: true,
  asarUnpack: [],
  extraMetadata: {
    name: 'gs-bot-license-generator',
    main: 'license-generator-app/main.js',
    description: 'Standalone license generator for GS Bot',
  },
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['arm64'],
      },
      {
        target: 'zip',
        arch: ['arm64'],
      },
    ],
    icon: 'icon.icns',
  },
  win: {
    signAndEditExecutable: false,
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    useZip: true,
    differentialPackage: false,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
  },
};
