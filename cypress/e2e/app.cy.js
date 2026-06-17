const PAUSE = 1000  // 1s per user request

// xterm's helper textarea is 0x0 by design — it's a hidden input managed by xterm.
// We must use { force: true } for all terminal interactions.

describe('tmuxremote — Full User Journey', () => {
  it('login, create tabs, use terminal, rename via modal, zoom, persistence', () => {
    // Step 1: Visit login page
    cy.visit('/')
    cy.contains('tmuxremote').should('be.visible')
    cy.wait(PAUSE)

    // Step 2: Login
    cy.get('#username').type('admin', { delay: 50 })
    cy.wait(PAUSE)
    cy.get('#password').type('tmuxremote', { delay: 50 })
    cy.wait(PAUSE)
    cy.get('button[type="submit"]').click()
    cy.wait(PAUSE * 2)

    // Step 3: Should be on app page with empty state
    cy.contains('No terminal tabs open').should('be.visible')
    cy.wait(PAUSE)

    // Step 4: Create first tab
    cy.contains('+ New Tab').click()
    cy.wait(PAUSE)
    cy.get('#newTabName').type('Main Terminal', { delay: 40 })
    cy.wait(PAUSE)
    cy.contains('button', 'Create').click()
    cy.wait(PAUSE * 2)

    // Step 5: Terminal should be visible
    cy.get('.tab-terminal.active .xterm').should('be.visible')
    cy.wait(PAUSE)

    // Step 6: Type a command in terminal
    cy.get('.tab-terminal.active .xterm-helper-textarea').focus({ force: true })
    cy.wait(PAUSE)
    cy.get('.tab-terminal.active .xterm-helper-textarea').type('echo "hello from cypress"{enter}', { delay: 30, force: true })
    cy.wait(PAUSE * 2)

    // Step 7: Verify output
    cy.get('.tab-terminal.active .xterm-rows').should('contain.text', 'hello from cypress')
    cy.wait(PAUSE)

    // Step 8: Test zoom out
    cy.get('#zoomOutBtn').click()
    cy.wait(PAUSE)
    cy.get('#zoomOutBtn').click()
    cy.wait(PAUSE)
    cy.get('#zoomLabel').should('contain.text', '12px')
    cy.wait(PAUSE)

    // Step 9: Test zoom in
    cy.get('#zoomInBtn').click()
    cy.wait(PAUSE)
    cy.get('#zoomLabel').should('contain.text', '13px')
    cy.wait(PAUSE)

    // Step 10: Reset zoom
    cy.get('#zoomLabel').click()
    cy.wait(PAUSE)
    cy.get('#zoomLabel').should('contain.text', '14px')
    cy.wait(PAUSE)

    // Step 11: Create second tab
    cy.get('#addTabBtn').click()
    cy.wait(PAUSE)
    cy.get('#newTabName').type('Second Tab', { delay: 40 })
    cy.wait(PAUSE)
    cy.contains('button', 'Create').click()
    cy.wait(PAUSE * 2)

    // Step 12: Type in second tab
    cy.get('.tab-terminal.active .xterm-helper-textarea').focus({ force: true })
    cy.wait(PAUSE)
    cy.get('.tab-terminal.active .xterm-helper-textarea').type('echo "second tab works"{enter}', { delay: 30, force: true })
    cy.wait(PAUSE * 2)

    cy.get('.tab-terminal.active .xterm-rows').should('contain.text', 'second tab works')
    cy.wait(PAUSE)

    // Step 13: Switch back to first tab
    cy.get('.tab').contains('Main Terminal').click()
    cy.wait(PAUSE * 2)

    // Step 14: First tab content still visible
    cy.get('.tab-terminal.active .xterm-rows').should('contain.text', 'hello from cypress')
    cy.wait(PAUSE)

    // Step 15: Rename via modal — double-click tab name
    cy.get('.tab.active .tab-name').dblclick()
    cy.wait(PAUSE)
    cy.get('.modal-overlay').should('be.visible')
    cy.get('#renameTabInput').should('have.value', 'Main Terminal')
    cy.wait(PAUSE)
    cy.get('#renameTabInput').clear().type('Production', { delay: 40 })
    cy.wait(PAUSE)
    cy.contains('button', 'Save').click()
    cy.wait(PAUSE)

    // Step 16: Verify rename
    cy.get('.tab').contains('Production').should('be.visible')
    cy.wait(PAUSE)

    // Step 17: Persistence — reload page
    cy.reload()
    cy.wait(PAUSE * 3)

    // Step 18: Tabs persist after reload
    cy.get('.tab').contains('Production').should('be.visible')
    cy.get('.tab').contains('Second Tab').should('be.visible')
    cy.wait(PAUSE)

    // Step 19: Terminal reconnects and works after reload
    cy.get('.tab-terminal.active .xterm-helper-textarea').focus({ force: true })
    cy.wait(PAUSE)
    cy.get('.tab-terminal.active .xterm-helper-textarea').type('echo "still alive"{enter}', { delay: 30, force: true })
    cy.wait(PAUSE * 2)
    cy.get('.tab-terminal.active .xterm-rows').should('contain.text', 'still alive')
    cy.wait(PAUSE)

    // Step 20: Second tab also persists
    cy.get('.tab').contains('Second Tab').click()
    cy.wait(PAUSE * 2)
    cy.get('.tab-terminal.active .xterm-helper-textarea').focus({ force: true })
    cy.wait(PAUSE)
    cy.get('.tab-terminal.active .xterm-helper-textarea').type('echo "persisted too"{enter}', { delay: 30, force: true })
    cy.wait(PAUSE * 2)
    cy.get('.tab-terminal.active .xterm-rows').should('contain.text', 'persisted too')
    cy.wait(PAUSE)

    // Done
    cy.log('✅ All features verified — login, tabs, terminal, zoom, rename modal, persistence!')
  })
})
