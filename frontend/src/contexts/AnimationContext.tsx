import React, { createContext, useContext, useState, useEffect } from 'react';

interface AnimationContextType {
  animationsEnabled: boolean;
  toggleAnimations: () => void;
}

const AnimationContext = createContext<AnimationContextType | undefined>(undefined);

export const AnimationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [animationsEnabled, setAnimationsEnabled] = useState<boolean>(() => {
    // Load from localStorage, default to true (animations ON by default)
    try {
      const saved = localStorage.getItem('animationsEnabled');
      // If preference exists in localStorage, use it; otherwise default to true (ON)
      return saved !== null ? saved === 'true' : true;
    } catch (error) {
      // If localStorage is not available (e.g., private browsing), default to true
      console.warn('localStorage not available, defaulting animations to ON:', error);
      return true;
    }
  });

  useEffect(() => {
    // Save to localStorage whenever it changes (persists across all pages)
    try {
      localStorage.setItem('animationsEnabled', String(animationsEnabled));
    } catch (error) {
      // If localStorage is not available, preference won't persist but will work in session
      console.warn('Could not save animation preference to localStorage:', error);
    }
  }, [animationsEnabled]);

  const toggleAnimations = () => {
    setAnimationsEnabled(prev => !prev);
  };

  return (
    <AnimationContext.Provider value={{ animationsEnabled, toggleAnimations }}>
      {children}
    </AnimationContext.Provider>
  );
};

export const useAnimation = () => {
  const context = useContext(AnimationContext);
  if (context === undefined) {
    throw new Error('useAnimation must be used within an AnimationProvider');
  }
  return context;
};

