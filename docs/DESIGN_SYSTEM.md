# Messengly V1.1 — Design System

## Typography

| Token | Value |
|-------|-------|
| `--font-sans` | `'Inter', system-ui, -apple-system, sans-serif` |
| `--font-mono` | `'JetBrains Mono', monospace` |
| Headings | weight 600–700, letter-spacing: -0.3px |
| Body | weight 400, line-height: 1.5, size 14px |
| Labels/Captions | weight 500, size 11–12px, uppercase |
| Small text | weight 400, size 12–13px |

## Color Palette

### Core

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#6366f1` Indigo-500 | Buttons, links, active states, outgoing messages |
| `--accent-hover` | `#4f46e5` Indigo-600 | Hover on accent elements |
| `--accent-bg` | `#eef2ff` Indigo-50 | Active chat bg, selection highlights |
| `--text` | `#1e293b` Slate-800 | Primary text |
| `--text-secondary` | `#64748b` Slate-500 | Descriptions, timestamps |
| `--text-muted` | `#94a3b8` Slate-400 | Hints, placeholders |
| `--bg` | `#ffffff` | Card/panel backgrounds |
| `--bg-secondary` | `#f8fafc` Slate-50 | Page bg, chat feed bg, metric cards |
| `--bg-tertiary` | `#f1f5f9` Slate-100 | Hover states |
| `--border` | `#e2e8f0` Slate-200 | Default borders |
| `--border-emphasis` | `#cbd5e1` Slate-300 | Hover/focus borders |

### Semantic

| Token | Color | Background |
|-------|-------|-----------|
| `--success` | `#16a34a` Green-600 | `#f0fdf4` Green-50 |
| `--warning` | `#d97706` Amber-600 | `#fffbeb` Amber-50 |
| `--danger` | `#dc2626` Red-600 | `#fef2f2` Red-50 |

### Messenger Colors

| Messenger | Background | Text/Icon |
|-----------|-----------|-----------|
| Telegram | `#e6f1fb` | `#0c447c` |
| Slack | `#eeedfe` | `#3c3489` |
| WhatsApp | `#eaf3de` | `#3b6d11` |
| Gmail | `#fcebeb` | `#a32d2d` |

## Sidebar

```css
.sidebar {
  background: linear-gradient(180deg, #1e1b4b 0%, #312e81 100%);
  width: 56px;
}

.nav-icon {
  color: rgba(255, 255, 255, 0.4);          /* inactive */
}
.nav-icon:hover {
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(8px);
  border-radius: 8px;
}
.nav-icon.active {
  color: rgba(255, 255, 255, 0.9);
  background: rgba(99, 102, 241, 0.15);      /* accent glass */
}

.logo {
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}
```

## Components

### Cards
```css
.card {
  background: var(--bg);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);     /* shadow-xs */
  /* NO border — shadows replace borders */
}
.card:hover {
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);  /* shadow-sm */
  transition: box-shadow 0.2s ease;
}
```

### Buttons

**Primary:**
```css
.btn-primary {
  background: var(--accent);
  color: #fff;
  border-radius: 8px;
  font-weight: 500;
  padding: 6px 14px;
  box-shadow: 0 1px 2px rgba(99, 102, 241, 0.3);
  transition: all 0.2s cubic-bezier(.4, 0, .2, 1);
}
.btn-primary:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(99, 102, 241, 0.4);
}
.btn-primary:active {
  transform: translateY(0) scale(0.98);
}
```

**Secondary:** bg white, border 1.5px solid var(--border), hover bg-tertiary + translateY(-1px)
**Ghost:** no bg/border, color text-secondary, hover bg-tertiary
**Danger:** color danger, border-color danger, hover danger-bg

### Inputs
```css
.input {
  border: 1.5px solid var(--border);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);   /* accent focus ring */
  outline: none;
}
```

### Pills & Tags
```css
.pill {
  border-radius: 20px;           /* rounded-full */
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
}
.tag {
  border-radius: 20px;
  padding: 4px 12px;
  font-size: 12px;
}
/* Text always darkest shade of same color as background */
```

### Modals
```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
}
.modal {
  background: var(--bg);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15), 0 4px 10px rgba(0, 0, 0, 0.08);
}
```

## Messenger-Specific

### Chat List (Left Panel)
```css
.chat-list {
  width: 300px;
}
.chat-item.active {
  background: var(--accent-bg);
  border-left: 3px solid var(--accent);
  padding-left: calc(14px - 3px);     /* compensate border */
}
.chat-item:hover {
  background: var(--bg-tertiary);
  transition: background 0.15s ease;
}
.chat-item .name.unread {
  font-weight: 600;
}
.unread-badge {
  background: var(--accent);
  color: #fff;
  border-radius: 10px;
  font-size: 10px;
  padding: 1px 5px;
}
```

### Chat Avatars
```css
.chat-avatar {
  width: 40px; height: 40px;        /* list */
  /* width: 34px; height: 34px;     header */
  /* width: 24px; height: 24px;     tables */
  border-radius: 14px;              /* rounded square, NOT circle */
  font-weight: 600;
}
.messenger-dot {
  width: 14px; height: 14px;
  border-radius: 50%;
  border: 2px solid var(--bg);
  position: absolute;
  bottom: -1px; right: -1px;
}
```

### Message Bubbles
```css
.bubble-incoming {
  background: var(--bg-secondary);
  border-radius: 18px 18px 18px 4px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  max-width: 65%;
}
.bubble-outgoing {
  background: var(--accent);
  color: #fff;
  border-radius: 18px 18px 4px 18px;
  box-shadow: 0 1px 3px rgba(99, 102, 241, 0.2);
  max-width: 65%;
}
.chat-feed {
  background: var(--bg-secondary);    /* soft gray bg */
}
.reply-quote {
  border-left: 3px solid var(--accent);
  background: rgba(0, 0, 0, 0.03);
  border-radius: 2px;
}
```

## Transitions

| Element | Transition |
|---------|-----------|
| All interactive | `all 0.2s cubic-bezier(.4, 0, .2, 1)` |
| Buttons hover | `translateY(-1px)` + shadow increase |
| Buttons active | `translateY(0) scale(0.98)` |
| Chat Info panel | `width 0.25s ease` |
| Modals open | `opacity + scale(0.95→1), 0.2s ease` |
| Chat list hover | `background 0.15s ease` |
| Focus ring | `box-shadow 0.15s ease` |

## Tailwind Config Reference

```js
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: '#6366f1', hover: '#4f46e5', bg: '#eef2ff' },
        slate: { /* use Tailwind defaults */ },
        messenger: {
          tg: { bg: '#e6f1fb', text: '#0c447c' },
          sl: { bg: '#eeedfe', text: '#3c3489' },
          wa: { bg: '#eaf3de', text: '#3b6d11' },
          gm: { bg: '#fcebeb', text: '#a32d2d' },
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
        full: '20px',
        avatar: '14px',
        bubble: '18px',
      },
      letterSpacing: {
        heading: '-0.3px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(0, 0, 0, 0.05)',
        sm: '0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06)',
        md: '0 4px 6px rgba(0, 0, 0, 0.1), 0 10px 25px rgba(0, 0, 0, 0.15)',
        'accent-sm': '0 1px 2px rgba(99, 102, 241, 0.3)',
        'focus-ring': '0 0 0 3px rgba(99, 102, 241, 0.15)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(.4, 0, .2, 1)',
      },
    },
  },
};
```
