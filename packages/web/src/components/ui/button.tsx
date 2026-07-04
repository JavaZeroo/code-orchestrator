import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 cursor-pointer whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-accent/90 text-white hover:bg-accent',
        secondary: 'bg-panel-2 border border-line hover:bg-line/60',
        ghost: 'hover:bg-panel-2 text-dim hover:text-ink',
        success: 'bg-ok/15 text-ok border border-ok/40 hover:bg-ok/25',
        danger: 'bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25',
        outline: 'border border-line hover:bg-panel-2',
      },
      size: {
        default: 'h-8 px-3 text-sm',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
