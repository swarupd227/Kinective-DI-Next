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
}

export function Menu({ trigger, items, align = 'end' }: MenuProps) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align={align} sideOffset={4} className={styles.content} collisionPadding={8}>
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
