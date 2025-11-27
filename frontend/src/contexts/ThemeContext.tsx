import React, { createContext, useContext, useState, useEffect, useLayoutEffect } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  isDarkMode: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Helper function to get the initial theme - used both for state init and immediate body class application
const getInitialTheme = (): Theme => {
  try {
    const saved = localStorage.getItem('theme');
    // Migration: check old 'animationsEnabled' key
    if (!saved) {
      const oldAnimationPref = localStorage.getItem('animationsEnabled');
      if (oldAnimationPref === 'false') {
        return 'light'; // User had animations disabled, migrate to light theme
      }
    }
    return (saved === 'light' || saved === 'dark') ? saved : 'dark';
  } catch (error) {
    console.warn('localStorage not available, defaulting to dark theme:', error);
    return 'dark';
  }
};

// CRITICAL: Apply theme class immediately on module load to prevent flash of wrong theme
// This runs BEFORE React even starts rendering, ensuring body has the correct class
if (typeof document !== 'undefined') {
  const initialTheme = getInitialTheme();
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(`theme-${initialTheme}`);
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    // Save to localStorage whenever theme changes
    try {
      localStorage.setItem('theme', theme);
      // Clean up old animation preference key
      localStorage.removeItem('animationsEnabled');
    } catch (error) {
      console.warn('Could not save theme preference to localStorage:', error);
    }
  }, [theme]);

  // Use useLayoutEffect to apply theme class SYNCHRONOUSLY before browser paints
  // This prevents flash of wrong theme when switching or on navigation
  useLayoutEffect(() => {
    // Apply theme class to body for CSS variable switching
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const isDarkMode = theme === 'dark';

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, isDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

// Backwards compatibility: export useAnimation as an alias
// This allows gradual migration of components
export const useAnimation = () => {
  const { isDarkMode, toggleTheme } = useTheme();
  return {
    animationsEnabled: isDarkMode,
    toggleAnimations: toggleTheme
  };
};



