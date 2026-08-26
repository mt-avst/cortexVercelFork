# Momentum Design System - Impact Lab

## Overview

The Momentum Design System is Impact Lab's visual design language, featuring a **dark theme with red accents** - a modern, high-contrast aesthetic that emphasizes clarity and energy.

## Design Principles

1. **Dark First**: All interfaces use dark backgrounds (#0A091A) with light text
2. **Red Momentum**: Electric Coral (#FF4E50) provides energy and focus
3. **Glassmorphism**: Subtle transparency creates depth and hierarchy
4. **High Contrast**: Ensures accessibility while maintaining modern aesthetics
5. **Consistent Spacing**: Uses systematic spacing tokens for visual rhythm

---

## Color System

### Primary Colors

#### Backgrounds
- **App Background**: `#0A091A` (Near-black, midnight blue)
  - CSS Variable: `--bg-app`
  - Used for: Main page backgrounds, containers
  - Gradient: `--bg-app-gradient-top` and `--bg-app-gradient-bottom` (currently same color)

- **Card Background**: `rgba(255, 255, 255, 0.05)` (Glassmorphism base)
  - CSS Variable: `--bg-card`
  - Used for: Cards, containers, elevated surfaces
  - Effect: Backdrop blur (16px) creates depth

- **Card Border**: `rgba(255, 255, 255, 0.1)` (Subtle light-catching border)
  - CSS Variable: `--border-card`
  - Used for: Card outlines, separators

#### Text Colors
- **Primary Text**: `#E0E0E0` (Light gray)
  - CSS Variable: `--text-primary`
  - Used for: Headings, titles, main content

- **Body Text**: `#E0E0E0` (Light gray)
  - CSS Variable: `--text-body`
  - Used for: Paragraphs, descriptions

- **Muted Text**: `rgba(224, 224, 224, 0.7)` (70% opacity light gray)
  - CSS Variable: `--text-muted`
  - Used for: Metadata, secondary information, timestamps

- **Text on Dark**: `#E0E0E0` (Light gray)
  - CSS Variable: `--text-on-dark`
  - Used for: Any text appearing on dark backgrounds

#### Brand Colors (Red Accents)
- **Electric Coral (Primary Red)**: `#FF4E50`
  - CSS Variable: `--brand-headline`
  - Used for: Primary buttons, active states, headlines, accents
  
- **CTA Background (Transparent default)**: `transparent`
  - CSS Variable: `--cta-bg`
  - Used for: Button backgrounds (transparent with border)

- **CTA Background (Hover)**: `#FF4E50`
  - CSS Variable: `--cta-bg-hover`
  - Used for: Button hover states

- **CTA Text**: `#FF4E50`
  - CSS Variable: `--cta-text`
  - Used for: Button text, links

- **CTA Text (Hover)**: `#FFFFFF`
  - CSS Variable: `--cta-text-hover`
  - Used for: Button text on hover (white)

- **CTA Border**: `#FF4E50`
  - CSS Variable: `--cta-border`
  - Used for: Button borders

- **Focus Ring**: `#FF4E50`
  - CSS Variable: `--focus-ring`
  - Used for: Focus outlines on interactive elements

#### Link Colors
- **Link**: `#FF7A33` (Slightly lighter orange-red)
  - CSS Variable: `--link`
  - Used for: Standard links

- **Link Hover**: `#FF974F` (Lighter orange)
  - CSS Variable: `--link-hover`
  - Used for: Link hover states

#### Status & Tag Colors
- **Tag Background**: `#222222` (Dark gray)
  - CSS Variables: `--tag-survey`, `--tag-poll`, `--tag-test`
  - Used for: Type badges, participant badges

- **Tag Text**: `#FFFFFF` (White)
  - CSS Variable: `--tag-text`
  - Used for: Text on dark tag backgrounds

- **Status Published**: `#28a745` (Bootstrap green)
  - Used for: Published status badges

- **Status Draft**: `#ffc107` (Bootstrap yellow, with black text)
  - Used for: Draft status badges

- **Status Closed**: `#6c757d` (Bootstrap gray)
  - Used for: Closed status badges

---

## Typography

### Font Family
- **Primary**: `'Inter'`, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif
- CSS Variable: `--font-family-base`

### Font Weights
- **H1**: `700` (Bold)
  - CSS Variable: `--font-weight-h1`
  
- **H2**: `600` (Semi-bold)
  - CSS Variable: `--font-weight-h2`
  
- **H3**: `600` (Semi-bold)
  - CSS Variable: `--font-weight-h3`
  
- **Body**: `400` (Regular)
  - CSS Variable: `--font-weight-body`
  
- **Card Title**: `600` (Semi-bold)
  - CSS Variable: `--font-weight-card-title`
  
- **Metadata**: `400` (Regular)
  - CSS Variable: `--font-weight-metadata`

### Font Sizes
- **H1**: `36px`
  - CSS Variable: `--font-size-h1`
  
- **H2**: `24px`
  - CSS Variable: `--font-size-h2`
  
- **H3**: `20px`
  - CSS Variable: `--font-size-h3`
  
- **Card Title**: `18px`
  - CSS Variable: `--font-size-card-title`
  
- **Body**: `15px`
  - CSS Variable: `--font-size-body`
  
- **Metadata**: `14px`
  - CSS Variable: `--font-size-metadata`

### Line Heights
- **Headings**: `1.25`
  - CSS Variable: `--line-height-heading`
  
- **Body**: `1.6`
  - CSS Variable: `--line-height-body`
  
- **Metadata**: `1.4`
  - CSS Variable: `--line-height-metadata`

---

## Component Styling

### Cards
- **Background**: `rgba(255, 255, 255, 0.05)` (Glassmorphism)
- **Border**: `1px solid rgba(255, 255, 255, 0.1)`
- **Border Radius**: `16px`
  - CSS Variable: `--card-radius`
- **Padding**: `24px`
  - CSS Variable: `--card-padding`
- **Shadow**: `0 2px 12px rgba(0,0,0,0.12)`
  - CSS Variable: `--shadow-card`
- **Hover Shadow**: `0 6px 16px rgba(0,0,0,0.16)`
  - CSS Variable: `--shadow-card-hover`
- **Hover Border**: Changes to `var(--brand-headline)` (#FF4E50)
- **Backdrop Filter**: `blur(16px)`

### Buttons

#### Primary Button
- **Background**: Transparent (default), `#FF4E50` (hover)
- **Border**: `1px solid #FF4E50`
- **Text**: `#FF4E50` (default), `#FFFFFF` (hover)
- **Border Radius**: `6px`
  - CSS Variable: `--button-radius`
- **Padding**: `10px 20px`
- **Font Weight**: `600`
- **Box Shadow**: `0 2px 4px rgba(0,0,0,0.2)` (default), `0 4px 10px rgba(0,0,0,0.22)` (hover)
- **Transition**: `all 0.2s ease-in-out`
- **Min Height**: `40px`
  - CSS Variable: `--min-hit-area`

### Badges/Tags

#### Type Badges (Test, Interview, Poll, Survey, Question)
- **Background**: `#222222` (Dark gray)
  - CSS Variables: `--tag-test`, `--tag-poll`, `--tag-survey`
- **Text**: `#FFFFFF` (White)
  - CSS Variable: `--tag-text`
- **Border Radius**: `99px` (Pill shape)
  - CSS Variable: `--tag-radius`
- **Padding**: `4px 10px`
  - CSS Variable: `--tag-padding`
- **Font Size**: `12px`
  - CSS Variable: `--tag-font-size`
- **Font Weight**: `500`
  - CSS Variable: `--tag-font-weight`
- **Text Transform**: `uppercase`
- **Display**: `inline-flex`
- **Hover**: `filter: brightness(103%)`
- **Transition**: `filter 180ms`
  - CSS Variable: `--transition-card`

#### Status Badges
- **Published**: Green background (`#28a745`), white text
- **Draft**: Yellow background (`#ffc107`), black text (`#000000`)
- **Closed**: Gray background (`#6c757d`), white text
- All use same styling tokens as type badges (radius, padding, font-size, font-weight)

#### Participant Badges
- Same styling as type badges
- Background: `#222222`
- Text: `#FFFFFF` with icons (👥 Any, 🏢 Internal, 🌐 External, 🎯 Specific)

### Tables

#### Table Container
- **Background**: Transparent (shows page background)
- **Border Radius**: `16px` (if wrapped in card)
  - CSS Variable: `--card-radius`

#### Table Header
- **Background**: `rgba(255, 255, 255, 0.05)` (Glassmorphism)
- **Text**: `#E0E0E0` (Light gray)
  - CSS Variable: `--text-primary`
- **Border Bottom**: `1px solid rgba(255, 255, 255, 0.1)`
- **Font Weight**: `600`
- **Padding**: `16px 12px`

#### Table Rows
- **Background**: Transparent (default)
- **Background (Hover)**: `rgba(255, 255, 255, 0.05)` (Glassmorphism)
- **Border Bottom**: `1px solid rgba(255, 255, 255, 0.05)` (Subtle)
- **Text**: `#E0E0E0` (Primary text)
  - CSS Variable: `--text-primary`
- **Muted Text**: `rgba(224, 224, 224, 0.7)` (Metadata)
  - CSS Variable: `--text-muted`
- **Padding**: `16px 12px`
- **Cursor**: `pointer` (for clickable rows)

#### Table Cells
- **Vertical Align**: `middle`
- **Title**: Bold, uses `--font-size-body` (15px), `--font-weight-card-title` (600)
- **Description**: Uses `--text-muted`, `--font-size-metadata` (14px)

---

## Spacing

### Spacing Tokens
- **Section Spacing**: `40px`
  - CSS Variable: `--spacing-section`
  - Used for: Spacing above first card row

- **Grid Gutter**: `32px`
  - CSS Variable: `--spacing-grid-gutter`
  - Used for: Gap between grid items

- **Vertical Rhythm**: `16px`
  - CSS Variable: `--spacing-vertical-rhythm`
  - Used for: Margin between cards

---

## Shadows

- **Button Shadow**: `0 2px 4px rgba(0,0,0,0.2)`
  - CSS Variable: `--shadow-button`
  
- **Button Hover Shadow**: `0 4px 10px rgba(0,0,0,0.22)`
  - CSS Variable: `--shadow-button-hover`
  
- **Card Shadow**: `0 2px 12px rgba(0,0,0,0.12)`
  - CSS Variable: `--shadow-card`
  
- **Card Hover Shadow**: `0 6px 16px rgba(0,0,0,0.16)`
  - CSS Variable: `--shadow-card-hover`

---

## Transitions

- **Card Transition**: `180ms`
  - CSS Variable: `--transition-card`
  - Used for: Card hover effects, badge hover effects
  
- **Button Transition**: `180ms`
  - CSS Variable: `--transition-button`
  - Used for: Button state changes

---

## Accessibility

### Focus States
- **Focus Outline**: `2px solid #FF4E50`
  - CSS Variable: `--focus-outline`
- **Focus Outline Offset**: `2px`
  - CSS Variable: `--focus-outline-offset`
- Applied to: All interactive elements (buttons, links, inputs, selects)

### Minimum Hit Areas
- **Minimum Hit Area**: `40px`
  - CSS Variable: `--min-hit-area`
- Applied to: Buttons, clickable badges, touch targets

### Contrast Ratios
All color combinations meet WCAG AA standards (≥4.5:1):
- White (#FFFFFF) on black (#0A091A): ~21:1
- Light gray (#E0E0E0) on black (#0A091A): ~12.6:1
- Electric Coral (#FF4E50) on black (#0A091A): ~3.5:1 (acceptable for large text)
- Electric Coral (#FF4E50) on white (#FFFFFF): ~3.5:1 (acceptable for large text)

---

## Usage Examples

### Example: Primary Button
```css
.btn-primary {
  background-color: var(--cta-bg);
  border: 1px solid var(--cta-border);
  color: var(--cta-text);
  border-radius: var(--button-radius);
  padding: 10px 20px;
  font-weight: 600;
  transition: all 0.2s ease-in-out;
}

.btn-primary:hover {
  background-color: var(--cta-bg-hover);
  color: var(--cta-text-hover);
}
```

### Example: Card
```css
.card {
  background: var(--bg-card);
  backdrop-filter: blur(16px);
  border: var(--card-border);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
  box-shadow: var(--shadow-card);
}
```

### Example: Badge
```css
.badge {
  background-color: var(--tag-test);
  color: var(--tag-text);
  border-radius: var(--tag-radius);
  padding: var(--tag-padding);
  font-size: var(--tag-font-size);
  font-weight: var(--tag-font-weight);
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
}
```

---

## Reference Implementation

All design tokens are defined in: `frontend/src/index.css` (starting at line 653)

This document serves as the authoritative reference for the Momentum Design System used throughout Impact Lab.

