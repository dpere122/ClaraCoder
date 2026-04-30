import { looksLikeLlamaModelDownload, managedLlamaCmdUsesHfRemoteModel } from '@shared/index';

describe('managedLlamaCmdUsesHfRemoteModel', () => {
  it('detects -hf token in shell command', () => {
    expect(managedLlamaCmdUsesHfRemoteModel('llama-server -hf org/model')).toBe(true);
    expect(managedLlamaCmdUsesHfRemoteModel('llama-server --hf-url https://x')).toBe(true);
  });

  it('returns false for plain GGUF paths', () => {
    expect(managedLlamaCmdUsesHfRemoteModel('llama-server -m C:\\models\\x.gguf')).toBe(false);
  });
});

describe('looksLikeLlamaModelDownload', () => {
  it('matches Hugging Face fetch patterns', () => {
    expect(looksLikeLlamaModelDownload('GET https://huggingface.co/foo/resolve/main/model.gguf')).toBe(true);
    expect(looksLikeLlamaModelDownload('Downloading model.safetensors 12%')).toBe(true);
    expect(
      looksLikeLlamaModelDownload(
        'common_download_file_single_online: no previous model file found C:\\llama.cpp\\nomic.gguf',
      ),
    ).toBe(true);
  });

  it('returns false for empty or unrelated logs', () => {
    expect(looksLikeLlamaModelDownload('')).toBe(false);
    expect(looksLikeLlamaModelDownload('listening on http://127.0.0.1:8080')).toBe(false);
  });
});
