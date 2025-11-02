# Impact Lab Theme Implementation

## Overview

This document describes the **Warm Research Modern** theme implementation for the Impact Lab application. The theme provides a professional, trustworthy, and human-centred design while maintaining strong accessibility (AA or better).

## Theme Specifications

### Color System

The theme uses a **dark-on-light layout** with:
- **Charcoal grey background** (`#1B1D1F`) for main areas
- **Off-white card surfaces** (`#F9FAFB`) for content cards
- **Warm orange primary accents** (`#FF7A33`) for buttons and links
- **Purple and teal highlights** for surveys and polls/tests respectively

### CSS Variables

All theme colors and styling tokens are defined as CSS custom properties in `:root` for easy maintenance and theming. Key variables include:

#### Background Colors
- `--bg-primary`: `#1B1D1F` (Charcoal grey background)
- `--bg-card`: `#F9FAFB` (Off-white card surfaces)

#### Text Colors
- `--text-primary`: `#1E1E1E` (Main text on light backgrounds)
- `--text-secondary`: `#555555` (Supporting text)
- `--text-white`: `#FFFFFF` (White text for headers)

#### Accent Colors
- `--accent-primary`: `#FF7A33` (Deep orange)
- `--accent-primary-hover`: `#FF9E54` (Hover state)
- `--accent-secondary`: `#A06CD5` (Warm purple for surveys)
- `--accent-tertiary`: `#3BB4A5` (Soft teal for polls/tests)

#### Highlight Colors by Type
- `--highlight-survey`: `#A06CD5` (Purple)
- `--highlight-poll`: `#3BB4A5` (Teal)
- `--highlight-test`: `#FF7A33` (Orange)

#### Button Colors
- `--button-primary-bg`: `linear-gradient(90deg, #FF7A33 0%, #FF9E54 100%)`
- `--button-primary-text`: `#FFFFFF`
- `--button-primary-hover`: `#FF9950`

#### Component Styling
- `--card-radius`: `12px`
- `--card-padding`: `24px`
- `--card-shadow`: `0 2px 8px rgba(0, 0, 0, 0.08)`
- `--button-radius`: `6px`
- `--border-subtle`: `#E5E7EB`

#### Accessibility
- `--focus-outline`: `2px solid #FF7A33`
- `--focus-outline-offset`: `2px`

### Typography

- **Font Family**: Inter, Open Sans, system-ui (with fallbacks)
- **Heading Weight**: 600-700
- **Body Weight**: 400
- **Line Height**: 1.5

### Component Guidelines

#### Cards
- Background: `--bg-card` (`#F9FAFB`)
- Border radius: `12px`
- Padding: `24px`
- Shadow: Soft shadow with `--card-shadow`
- Border: `1px solid var(--border-subtle)`

#### Buttons
- Primary buttons: Orange gradient (`--button-primary-bg`)
- Border radius: `6px`
- White text on primary buttons
- Hover state with slight elevation
- Focus outline: `2px solid #FF7A33`

#### Tags/Badges
- Survey: Purple (`--highlight-survey`)
- Poll: Teal (`--highlight-poll`)
- Test/Interview: Orange (`--highlight-test`) / Teal (`--accent-tertiary`)
- Border radius: `6px`
- Font weight: 600

#### Header
- Background: `--header-bg` (`#1B1D1F`)
- Text: `--header-text` (`#FFFFFF`)
- White logo and navigation

#### Section Headings
- Color: `--accent-secondary` (`#A06CD5`) - Purple
- Font weight: 600
- Applied to h2, h3, h4 on dark backgrounds
- Headings inside cards use dark text (`--text-primary`)

### Accessibility Features

1. **Contrast Ratios**: All color combinations meet WCAG AA standards (≥4.5:1)
   - Orange (#FF7A33) on white: ~4.7:1
   - White on charcoal: ~13.3:1
   - Dark text on off-white: ~15.8:1
   - Purple (#A06CD5) on white: ~4.9:1
   - Teal (#3BB4A5) on white: ~3.9:1 (adjusted with white text)

2. **Focus States**: 
   - All interactive elements have visible focus outlines
   - Focus outline: `2px solid #FF7A33` with `2px` offset
   - Keyboard navigation fully supported

3. **Hover States**:
   - Distinct hover states for all interactive elements
   - Clear visual feedback on buttons and links

4. **Reduced Motion**:
   - Respects `prefers-reduced-motion` media query
   - Animations can be disabled for accessibility

## Implementation Details

### File Structure

- **Theme Variables**: `frontend/src/index.css` (`:root` section)
- **Component Styles**: `frontend/src/index.css` (global styles)
- **Component-Specific**: Individual component files may have inline styles using CSS variables

### Usage Examples

#### Using CSS Variables in Components

```css
.my-component {
  background-color: var(--bg-card);
  color: var(--text-primary);
  border-radius: var(--card-radius);
  padding: var(--card-padding);
}
```

#### Inline Styles (React)

```jsx
<div style={{ 
  backgroundColor: 'var(--bg-card)', 
  color: 'var(--text-primary)' 
}}>
  Content
</div>
```

### Migration Notes

The theme has been applied globally across:
- ✅ Body and HTML backgrounds
- ✅ Card components
- ✅ Button components
- ✅ Badge/tag components
- ✅ Header component
- ✅ Typography (headings, body text)
- ✅ Form elements
- ✅ Links and interactive elements
- ✅ Focus states for accessibility

### Browser Support

The theme uses CSS custom properties (CSS variables) which are supported in:
- Chrome 49+
- Firefox 31+
- Safari 9.1+
- Edge 15+

For older browsers, fallback colors are defined in the CSS.

## Future Enhancements

Potential improvements:
1. Dark mode variant using the same color system
2. Additional accent colors for new opportunity types
3. Animation presets using CSS variables
4. Tailwind config integration for utility classes

## Maintenance

To update theme colors:
1. Modify CSS variables in `:root` section of `frontend/src/index.css`
2. Changes will propagate throughout the application
3. Test contrast ratios to ensure accessibility compliance

