const DEFAULTS = {
  positioning: { linkClick: 'right', blankNewTab: 'right', reopened: 'right' },
  focus:       { linkClick: 'foreground', blankNewTab: 'foreground' },
  onClose:     { activate: 'last-used' },
  moveToOpenerGroup: true,
  preventDuplicates: false,
  enabled: true,
  theme: 'system',
};

const POS_OPTIONS = [
  { value: 'right',     label: 'Right' },
  { value: 'left',      label: 'Left'  },
  { value: 'end',       label: 'End'   },
  { value: 'beginning', label: 'Start' },
  { value: 'default',   label: 'Off'   },
];

const FOCUS_OPTIONS = [
  { value: 'foreground', label: 'Front' },
  { value: 'background', label: 'Back'  },
  { value: 'default',    label: 'Off'   },
];

const THEME_OPTIONS = [
  { value: 'light',  label: 'Light'  },
  { value: 'system', label: 'Auto'   },
  { value: 'dark',   label: 'Dark'   },
];

const ACTIVATE_OPTIONS = [
  { value: 'left',      label: 'Left'    },
  { value: 'right',     label: 'Right'   },
  { value: 'opener',    label: 'Opener'  },
  { value: 'last-used', label: 'Last'    },
  { value: 'default',   label: 'Default' },
];

function buildSeg(containerId, options, name, currentValue, onChange) {
  const el = document.getElementById(containerId);
  options.forEach(({ value, label }) => {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.id = `${name}--${value}`;
    if (value === currentValue) input.checked = true;
    input.addEventListener('change', () => onChange(value));

    const lbl = document.createElement('label');
    lbl.htmlFor = input.id;
    lbl.textContent = label;

    el.appendChild(input);
    el.appendChild(lbl);
  });
}

function readSeg(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function applyTheme(theme) {
  document.documentElement.style.colorScheme = theme === 'system' ? '' : theme;
}

function save(patch) {
  chrome.storage.sync.set(patch);
}

async function init() {
  const raw = await chrome.storage.sync.get(null);
  const s = {
    ...DEFAULTS, ...raw,
    positioning: { ...DEFAULTS.positioning, ...(raw.positioning ?? {}) },
    focus:       { ...DEFAULTS.focus,       ...(raw.focus       ?? {}) },
    onClose:     { ...DEFAULTS.onClose,     ...(raw.onClose     ?? {}) },
  };

  // Theme
  applyTheme(s.theme);
  buildSeg('theme-control', THEME_OPTIONS, 'theme', s.theme, val => {
    applyTheme(val);
    save({ theme: val });
  });

  // Master toggle
  const enabledEl = document.getElementById('enabled');
  enabledEl.checked = s.enabled;
  if (!s.enabled) document.body.classList.add('disabled');
  enabledEl.addEventListener('change', () => {
    document.body.classList.toggle('disabled', !enabledEl.checked);
    save({ enabled: enabledEl.checked });
  });

  // Positioning
  ['linkClick', 'blankNewTab', 'reopened'].forEach(trigger => {
    buildSeg(`pos-${trigger}`, POS_OPTIONS, `pos-${trigger}`, s.positioning[trigger], val => {
      save({
        positioning: {
          linkClick:   readSeg('pos-linkClick')   ?? s.positioning.linkClick,
          blankNewTab: readSeg('pos-blankNewTab') ?? s.positioning.blankNewTab,
          reopened:    readSeg('pos-reopened')    ?? s.positioning.reopened,
          [trigger]:   val,
        },
      });
    });
  });

  // Focus
  ['linkClick', 'blankNewTab'].forEach(trigger => {
    buildSeg(`focus-${trigger}`, FOCUS_OPTIONS, `focus-${trigger}`, s.focus[trigger], val => {
      save({
        focus: {
          linkClick:   readSeg('focus-linkClick')   ?? s.focus.linkClick,
          blankNewTab: readSeg('focus-blankNewTab') ?? s.focus.blankNewTab,
          [trigger]:   val,
        },
      });
    });
  });

  // After closing - segmented control (was a native <select>)
  buildSeg('onClose-activate', ACTIVATE_OPTIONS, 'onClose-activate', s.onClose.activate, val => {
    save({ onClose: { activate: val } });
  });

  // Extras
  const groupEl = document.getElementById('moveToOpenerGroup');
  groupEl.checked = s.moveToOpenerGroup;
  groupEl.addEventListener('change', () => save({ moveToOpenerGroup: groupEl.checked }));

  const dupeEl = document.getElementById('preventDuplicates');
  dupeEl.checked = s.preventDuplicates;
  dupeEl.addEventListener('change', () => save({ preventDuplicates: dupeEl.checked }));
}

init();
