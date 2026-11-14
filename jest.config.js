module.exports = {
  preset: 'jest-expo/android',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  clearMocks: true,
  collectCoverageFrom: ['src/lib/**/*.ts', 'src/config/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', 'src/lib/supabase.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^expo-crypto$': '<rootDir>/tests/mocks/expo-crypto.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|expo-.*|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-url-polyfill)/)',
  ],
};
