// UI Component Library - Momentum Design System
// 
// This module exports all reusable UI components for the application.
// These components are styled using the Momentum Design System CSS
// and provide type-safe props interfaces.

// ============================================
// Custom Momentum Design System Components
// ============================================

export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { 
  Card, 
  CardHeader, 
  CardBody, 
  CardFooter, 
  CardTitle,
  type CardProps,
  type CardHeaderProps,
  type CardBodyProps,
  type CardFooterProps,
  type CardTitleProps 
} from './Card';
export { 
  Badge, 
  Lozenge, 
  StatusBadge,
  type BadgeProps, 
  type BadgeVariant,
  type BadgeSize,
  type LozengeProps,
  type StatusBadgeProps,
  type StatusType
} from './Badge';
export { Alert, type AlertProps, type AlertVariant } from './Alert';
export { Spinner, Loading, type SpinnerProps, type SpinnerSize, type LoadingProps } from './Spinner';
export { 
  Dropdown, 
  DropdownItem, 
  DropdownDivider, 
  DropdownHeader,
  type DropdownProps,
  type DropdownItemProps,
  type DropdownDividerProps,
  type DropdownHeaderProps
} from './Dropdown';

// ============================================
// shadcn/ui Components (Radix UI based)
// ============================================

// Avatar - User profile images with fallback
export { Avatar, AvatarImage, AvatarFallback } from './avatar';

// Tabs - Tabbed navigation component
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

// Tooltip - Hover tooltips
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';

// Sheet - Slide-out panel/drawer
export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './sheet';

// Carousel - Image/content carousel
export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from './carousel';
