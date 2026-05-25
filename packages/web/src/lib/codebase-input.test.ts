import { describe, expect, test } from 'bun:test';
import { getCodebaseInput } from '@/lib/codebase-input';

describe('getCodebaseInput', () => {
  test('treats GitHub repository inputs as urls', () => {
    expect(getCodebaseInput('https://github.com/coleam00/Smelter')).toEqual({
      url: 'https://github.com/coleam00/Smelter',
    });
  });

  test('treats SSH git@ shorthand as urls', () => {
    expect(getCodebaseInput('git@github.com:coleam00/Smelter.git')).toEqual({
      url: 'git@github.com:coleam00/Smelter.git',
    });
  });

  test('treats ssh:// URLs as urls', () => {
    expect(getCodebaseInput('ssh://git@github.com/coleam00/Smelter.git')).toEqual({
      url: 'ssh://git@github.com/coleam00/Smelter.git',
    });
  });

  test('treats git:// URLs as urls', () => {
    expect(getCodebaseInput('git://github.com/coleam00/Smelter.git')).toEqual({
      url: 'git://github.com/coleam00/Smelter.git',
    });
  });

  test('trims surrounding whitespace before classifying', () => {
    expect(getCodebaseInput('  https://github.com/a/b  ')).toEqual({
      url: 'https://github.com/a/b',
    });
  });

  test('treats relative local paths as paths', () => {
    expect(getCodebaseInput('./repo')).toEqual({ path: './repo' });
    expect(getCodebaseInput('../repo')).toEqual({ path: '../repo' });
    expect(getCodebaseInput('repo')).toEqual({ path: 'repo' });
  });

  test('treats unix local paths as paths', () => {
    expect(getCodebaseInput('/path/to/repository')).toEqual({
      path: '/path/to/repository',
    });
  });

  test('treats home-relative paths as paths', () => {
    expect(getCodebaseInput('~/src/smelter')).toEqual({
      path: '~/src/smelter',
    });
  });

  test('treats windows local paths as paths', () => {
    expect(getCodebaseInput('C:\\repo\\smelter')).toEqual({
      path: 'C:\\repo\\smelter',
    });
  });

  test('treats windows UNC paths as paths', () => {
    expect(getCodebaseInput('\\\\server\\share\\smelter')).toEqual({
      path: '\\\\server\\share\\smelter',
    });
  });
});
