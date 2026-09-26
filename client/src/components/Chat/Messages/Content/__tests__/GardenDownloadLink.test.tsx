import React from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosAdapter } from 'axios';
import { QueryKeys } from 'librechat-data-provider';
import { getMarkdownComponents } from '../markdownConfig';
import store from '~/store';

const fileId = '7a03db0b-70a1-47d0-b2c1-d903bb6548a4';
const fixtureBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x19]);

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

it('downloads rendered Garden handoff bytes through the authenticated file client', async () => {
  const originalAdapter = axios.defaults.adapter;
  const originalAuthorization = axios.defaults.headers.common.Authorization;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let downloadedBlob: Blob | undefined;
  const requests: Array<{ url?: string; authorization: unknown; responseType?: string }> = [];
  const nativeDownloadClicks: Array<{ href: string; filename: string }> = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  queryClient.setQueryData([QueryKeys.files], []);

  axios.defaults.headers.common.Authorization = 'Bearer fixture-token';
  axios.defaults.adapter = (async (config) => {
    requests.push({
      url: config.url,
      authorization: config.headers.get('Authorization'),
      responseType: config.responseType,
    });
    if (
      config.url !== `/api/files/download/u1/${fileId}` ||
      config.headers.get('Authorization') !== 'Bearer fixture-token'
    ) {
      return { data: null, status: 401, statusText: 'Unauthorized', headers: {}, config };
    }
    return {
      data: new Blob([fixtureBytes], { type: 'application/octet-stream' }),
      status: 200,
      statusText: 'OK',
      headers: {
        'x-file-metadata': encodeURIComponent(JSON.stringify({
          file_id: fileId,
          filename: 'qa-note.docx',
          source: 'local',
        })),
      },
      config,
    };
  }) as AxiosAdapter;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: jest.fn((blob: Blob) => {
      downloadedBlob = blob;
      return 'blob:http://localhost:3080/garden-fixture';
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const nativeClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    nativeDownloadClicks.push({ href: this.href, filename: this.download });
  });

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot initializeState={({ set }) => set(store.user, { id: 'u1' } as never)}>
          <ReactMarkdown components={getMarkdownComponents()}>
            {`[qa-note.docx](/api/files/download/u1/${fileId})`}
          </ReactMarkdown>
        </RecoilRoot>
      </QueryClientProvider>,
    );

    const link = screen.getByRole('link', { name: 'qa-note.docx' });
    expect(link).toHaveAttribute('href', `/api/files/download/u1/${fileId}`);
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(nativeDownloadClicks).toHaveLength(1));

    expect(requests).toEqual([{
      url: `/api/files/download/u1/${fileId}`,
      authorization: 'Bearer fixture-token',
      responseType: 'blob',
    }]);
    expect(nativeDownloadClicks).toEqual([{
      href: 'blob:http://localhost:3080/garden-fixture',
      filename: 'qa-note.docx',
    }]);
    expect(downloadedBlob).toBeInstanceOf(Blob);
    expect(Array.from(await readBlob(downloadedBlob as Blob))).toEqual(Array.from(fixtureBytes));
  } finally {
    queryClient.clear();
    nativeClick.mockRestore();
    axios.defaults.adapter = originalAdapter;
    axios.defaults.headers.common.Authorization = originalAuthorization;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  }
});
