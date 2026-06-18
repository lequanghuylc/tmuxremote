// Settings tab module
export const DEFAULT_SETTINGS = {
  fontSize: 14,
  theme: 'dark',
  autoSave: false,
  wordWrap: true,
  tabSize: 2,
  minimap: true,
  cursorBlinking: true,
  lineHeight: 1.5,
};

export function loadSettings() {
  try {
    const saved = localStorage.getItem('tmuxremote_settings');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem('tmuxremote_settings', JSON.stringify(settings));
}

export function renderSettingsPanel(container, settings, onChange) {
  container.innerHTML = '';
  
  const wrapper = document.createElement('div');
  wrapper.className = 'settings-panel';
  wrapper.innerHTML = `
    <div class="settings-section">
      <h3><i class="lni lni-text-format"></i> Editor</h3>
      <div class="setting-row">
        <label>Font Size</label>
        <div class="setting-control">
          <input type="range" id="settFontSize" min="8" max="32" value="${settings.fontSize}" step="1">
          <span class="setting-value">${settings.fontSize}px</span>
        </div>
      </div>
      <div class="setting-row">
        <label>Tab Size</label>
        <select id="settTabSize">
          <option value="2" ${settings.tabSize === 2 ? 'selected' : ''}>2 spaces</option>
          <option value="4" ${settings.tabSize === 4 ? 'selected' : ''}>4 spaces</option>
          <option value="8" ${settings.tabSize === 8 ? 'selected' : ''}>8 spaces</option>
        </select>
      </div>
      <div class="setting-row">
        <label>Word Wrap</label>
        <label class="toggle">
          <input type="checkbox" id="settWordWrap" ${settings.wordWrap ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="setting-row">
        <label>Show Minimap</label>
        <label class="toggle">
          <input type="checkbox" id="settMinimap" ${settings.minimap ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="setting-row">
        <label>Cursor Blinking</label>
        <label class="toggle">
          <input type="checkbox" id="settCursorBlink" ${settings.cursorBlinking ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <h3><i class="lni lni-monitor-code"></i> Terminal</h3>
      <div class="setting-row">
        <label>Font Size</label>
        <div class="setting-control">
          <input type="range" id="settTermFontSize" min="8" max="32" value="${settings.fontSize}" step="1">
          <span class="setting-value">${settings.fontSize}px</span>
        </div>
      </div>
      <div class="setting-row">
        <label>Line Height</label>
        <div class="setting-control">
          <input type="range" id="settLineHeight" min="1.0" max="2.0" value="${settings.lineHeight}" step="0.1">
          <span class="setting-value">${settings.lineHeight}</span>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3><i class="lni lni-floppy-disk-1"></i> Saving</h3>
      <div class="setting-row">
        <label>Auto-save</label>
        <label class="toggle">
          <input type="checkbox" id="settAutoSave" ${settings.autoSave ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="setting-row help-text">
        When enabled, files are saved automatically after 1 second of inactivity. When disabled, use Ctrl+S / Cmd+S to save manually.
      </div>
    </div>
  `;
  
  container.appendChild(wrapper);

  // Event listeners
  const handleChange = (id, key, transform = v => v) => {
    const el = wrapper.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('input', () => {
      settings[key] = transform(el.type === 'checkbox' ? el.checked : el.value);
      if (el.type === 'range') {
        el.nextElementSibling.textContent = key === 'lineHeight' ? el.value : el.value + 'px';
      }
      saveSettings(settings);
      onChange(key, settings[key]);
    });
  };

  handleChange('settFontSize', 'fontSize', Number);
  handleChange('settTabSize', 'tabSize', Number);
  handleChange('settWordWrap', 'wordWrap', Boolean);
  handleChange('settMinimap', 'minimap', Boolean);
  handleChange('settCursorBlink', 'cursorBlinking', Boolean);
  handleChange('settAutoSave', 'autoSave', Boolean);
  handleChange('settTermFontSize', 'fontSize', Number);
  handleChange('settLineHeight', 'lineHeight', Number);
}
