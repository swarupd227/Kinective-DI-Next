import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2 } from 'lucide-react';
import styles from './Toast.module.css';

interface ToastApi {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

/** Small status toasts for workbench actions that later slices wire to real behaviour. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  const show = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3200);
  }, []);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={styles.toast}>
            <CheckCircle2 size={16} aria-hidden />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
