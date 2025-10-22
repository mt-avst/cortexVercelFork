// Simple test to verify the frontend test setup works
import '@testing-library/jest-dom';

describe('Frontend Test Setup', () => {
  it('should run basic tests', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have testing utilities available', () => {
    expect(typeof expect).toBe('function');
    expect(typeof describe).toBe('function');
    expect(typeof it).toBe('function');
  });

  it('should be able to import React', () => {
    const React = require('react');
    expect(typeof React).toBe('object');
  });
});
