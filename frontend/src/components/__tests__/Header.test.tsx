import React from 'react';
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Header from '../Header';

// Simple Header component tests
describe('Header Component', () => {
  it('should render without crashing', () => {
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it('should render logo', () => {
    const { getByAltText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    expect(getByAltText('Adaptalabs Logo')).toBeInTheDocument();
  });

  it('should render navigation elements', () => {
    const { getByText } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    
    // These elements should be present regardless of auth state
    expect(getByText('Sign In')).toBeInTheDocument();
    expect(getByText('Demo Login')).toBeInTheDocument();
    expect(getByText('Admin Demo')).toBeInTheDocument();
  });

  it('should have proper structure', () => {
    const { container } = render(
      <BrowserRouter>
        <Header />
      </BrowserRouter>
    );
    
    const header = container.querySelector('header');
    expect(header).toBeInTheDocument();
    expect(header).toHaveClass('header');
  });
});
