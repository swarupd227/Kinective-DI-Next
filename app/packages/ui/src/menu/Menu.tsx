import type { ReactElement, ReactNode } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import styles from './Menu.module.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  trigger: ReactElement;
  items: MenuItem[];
  align?: 'start' | 'end';
  /** Opened by the caller (a click on a chart point) rather than by its trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Read before the items, for example the point a chart menu is about. */
  heading?: string;
}

export function Menu({ trigger, items, align = 'end', open, onOpenChange, heading }: MenuProps) {
  return (
    <Dropdown.Root {...(open === undefined ? {} : { open, onOpenChange })}>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} sideOffset={4} className={styles.content} collisionPadding={8}>
          {heading && <Dropdown.Label className={styles.heading}>{heading}</Dropdown.Label>}
          {items.map((item) => (
            <Dropdown.Item key={item.id} className={styles.item} disabled={item.disabled} onSelect={item.onSelect}>
              {item.icon && <span className={styles.icon}>{item.icon}</span>}
              {item.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
