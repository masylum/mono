import {useRef, useState} from 'react';

import CloseIcon from '../../assets/icons/close.svg?react';
import Modal from '../../components/modal.js';

interface Props {
  onDismiss?: () => void;
  isOpen: boolean;
}

export default function IssueComposer({isOpen, onDismiss}: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState<string>();

  const handleSubmit = async () => {
    // ..
  };

  const reset = () => {
    setTitle('');
    setDescription('');
  };

  const handleClickCloseBtn = () => {
    reset();
    if (onDismiss) onDismiss();
  };

  const body = (
    <div className="flex flex-col w-full py-4 overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0 px-4">
        <div className="flex items-center">
          <span className="ml-1 font-normal text-white">New Issue</span>
        </div>
        <div className="flex items-center">
          <button
            className="inline-flex rounded items-center justify-center ml-2 text-gray-500 h-7 w-7 hover:bg-gray-100 rouned hover:text-gray-700"
            onMouseDown={handleClickCloseBtn}
          >
            <CloseIcon className="w-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-col flex-1 pb-3.5 overflow-y-auto">
        <div className="flex items-center w-full mt-1.5 px-4">
          <input
            className="bg-modal w-full ml-1.5 text-lg font-semibold placeholder-gray-400 border-none h-7 focus:border-none focus:outline-none focus:ring-0"
            placeholder="Issue title"
            value={title}
            ref={ref}
            onChange={e => setTitle(e.target.value)}
          />
        </div>
        <div className="w-full px-4">
          <textarea
            className="bg-modal prose w-full max-w-full mt-2 font-normal appearance-none min-h-12 p-1 text-md editor border border-transparent focus:outline-none focus:ring-0"
            value={description || ''}
            onChange={e => setDescription(e.target.value)}
            placeholder="Add description..."
          ></textarea>
        </div>
      </div>
      <div className="flex items-center flex-shrink-0 px-4 pt-3">
        <button
          className="px-3 ml-auto text-black bg-primary rounded h-7"
          onClick={handleSubmit}
        >
          Save Issue
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      center={false}
      size="large"
      onDismiss={() => {
        reset();
        onDismiss?.();
      }}
    >
      {body}
    </Modal>
  );
}
