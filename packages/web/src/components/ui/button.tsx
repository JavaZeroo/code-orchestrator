import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap cursor-pointer outline-none transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-accent-ink hover:bg-accent-2 shadow-[0_1px_0_oklch(1_0_0/0.15)_inset,0_6px_16px_-8px_var(--color-accent)]',
        secondary: 'bg-panel-2 border border-line text-ink-2 hover:bg-panel-3 hover:text-ink hover:border-line-2',
        ghost: 'text-dim hover:bg-panel-2 hover:text-ink',
        success: 'bg-ok/12 text-ok border border-ok/35 hover:bg-ok/20',
        danger: 'bg-danger/12 text-danger border border-danger/35 hover:bg-danger/22',
        outline: 'border border-line text-ink-2 hover:bg-panel-2 hover:border-line-2',
      },
      size: {
        default: 'h-8 px-3.5 text-[13px]',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7',
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
