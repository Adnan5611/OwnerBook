const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Android-only native application. Do not substitute a website for the APK.
config.resolver.platforms = ['android', 'native'];

module.exports = config;
