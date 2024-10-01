import React, {
  type RefObject,
  useCallback,
  useRef,
  type MouseEvent,
} from 'react';
import ReactDOM from 'react-dom';
import classnames from 'classnames';

import CloseIcon from '../assets/icons/close.svg?react';
import useLockBodyScroll from '../hooks/use-lock-body-scroll.js';
import {Transition} from '@headlessui/react';

interface Props {
  title?: string;
  isOpen: boolean;
  center: boolean;
  className?: string;
  onDismiss?: (() => void) | undefined;
  children?: React.ReactNode;
  size: keyof typeof sizeClasses;
}
const sizeClasses = {
  large: 'max-w-2xl w-1/2',
  normal: 'max-w-md w-1/3',
};

export default function Modal({
  title,
  isOpen,
  center,
  size,
  className,
  onDismiss,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>;
  const outerRef = useRef(null);

  const wrapperClasses = classnames(
    'fixed flex flex-col items-center inset-0 z-50',
    {
      'justify-center': center,
    },
  );
  const modalClasses = classnames(
    'flex flex-col items-center overflow-hidden transform bg-modal modal shadow-large-modal rounded-xl border border-modalOutline',
    {
      'mt-20 mb-2 ': !center,
    },
    sizeClasses[size],
    className,
  );
  const handleClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      if (!onDismiss) return;
      if (ref.current && !ref.current.contains(event.target as Element)) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  useLockBodyScroll();

  const modal = (
    <div ref={outerRef} onClick={handleClick}>
      <Transition
        show={isOpen}
        enter="transition ease-out duration-100"
        enterFrom="transform opacity-0 scale-95"
        enterTo="transform opacity-100 scale-100"
        leave="transition easy-in duration-95"
        leaveFrom="transform opacity-100 scale-100"
        leaveTo="transform opacity-0 scale-95"
      >
        <div className={wrapperClasses}>
          <div ref={ref} className={modalClasses}>
            {title && (
              <div className="flex items-center justify-between w-full pl-8 pr-4 border-b border-gray-200">
                <div className="text-sm font-semibold text-white">{title}</div>
                <div className="p-4" onMouseDown={onDismiss}>
                  <CloseIcon className="w-4 text-gray-500 hover:text-gray-700" />
                </div>
              </div>
            )}
            {children}
          </div>
        </div>
      </Transition>
    </div>
  );

  return ReactDOM.createPortal(
    modal,
    document.getElementById('root-modal') as Element,
  );
}

Modal.defaultProps = {
  size: 'normal',
  center: true,
};
