import React from 'react';
import { request } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import HelpReceiptView from './Receipt';
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({ request: { post: jest.fn() } }));
jest.mock('@librechat/client', () => ({
  Button: (props: Record<string, unknown>) =>
    jest.requireActual('react').createElement('button', props),
}));
test('recoverable failure checks/retries the same approved ID without another approval', async () => {
  (request.post as jest.Mock).mockResolvedValue({ feedback_id: '28', issue_id: '12' });
  render(
    <HelpReceiptView
      output={JSON.stringify({
        submission_id: 'same-approved-submission',
        error: { code: 'BUSY', retryable: true },
      })}
    />,
  );
  expect(screen.queryByText('com_ui_help_saved')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_help_check' }));
  await screen.findByText('com_ui_help_saved');
  expect(request.post).toHaveBeenCalledWith(
    '/api/garden/help/submissions/same-approved-submission/retry',
    {},
  );
  expect(screen.queryByRole('button')).toBeNull();
});
test('an assistant sentence is never a server receipt', () => {
  render(<HelpReceiptView output="Saved successfully" />);
  expect(screen.getByText('com_ui_help_unknown')).toBeVisible();
  expect(screen.queryByText('com_ui_help_saved')).toBeNull();
});
