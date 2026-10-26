import { useWatch } from 'react-hook-form';
import { Button } from '@librechat/client';
import { useChatFormContext } from '~/Providers';
import { useLocalize } from '~/hooks';

export default function HelpStarters({ focus }: { focus: () => void }) {
  const localize = useLocalize();
  const { setValue, control } = useChatFormContext();
  const text = useWatch({ control, name: 'text' });
  if (text) return null;
  return (
    <div className="flex flex-wrap gap-2 p-3">
      {(
        ['com_ui_help_start_chat', 'com_ui_help_start_problem', 'com_ui_help_start_wish'] as const
      ).map((key) => (
        <Button
          key={key}
          className="min-h-11 whitespace-normal"
          onClick={() => {
            setValue('text', localize(key));
            focus();
          }}
        >
          {localize(key)}
        </Button>
      ))}
    </div>
  );
}
