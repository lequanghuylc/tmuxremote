const { defineConfig } = require('cypress')

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4567',
    video: true,
    videoCompression: 32,
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 15000,
    pageLoadTimeout: 30000,
    supportFile: false,
    specPattern: 'cypress/e2e/**/*.cy.{js,ts}',
  },
})
