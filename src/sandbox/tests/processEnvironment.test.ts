// 子进程环境净化测试: 白名单重建, 凭据与注入变量默认不存在。
import { describe, expect, it } from 'vitest';
import { buildProcessEnvironment } from '../processEnvironment.js';

describe('buildProcessEnvironment', () => {
  it('保留命令查找/用户目录/临时目录/区域变量', () => {
    const env = buildProcessEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/u',
      USERPROFILE: 'C:\\Users\\u',
      TEMP: '/tmp',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      MSYSTEM: 'MINGW64',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.USERPROFILE).toBe('C:\\Users\\u');
    expect(env.TEMP).toBe('/tmp');
    expect(env.LANG).toBe('zh_CN.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.MSYSTEM).toBe('MINGW64');
  });

  it('凭据与注入变量一律丢弃', () => {
    const env = buildProcessEnvironment({
      OPENAI_API_KEY: 'sk-leak',
      GITHUB_TOKEN: 'ghp_leak',
      DB_PASSWORD: 'pw',
      SSH_AUTH_SOCK: '/run/ssh-agent',
      NODE_OPTIONS: '--inspect',
      BASH_ENV: '/tmp/evil.sh',
      LD_PRELOAD: '/tmp/evil.so',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      PYTHONPATH: '/tmp/evil',
      npm_config_registry: 'https://evil',
    });

    expect(Object.keys(env)).toEqual(['TERM', 'PAGER', 'GIT_PAGER']);
  });

  it('强制非交互终端行为', () => {
    const env = buildProcessEnvironment({ TERM: 'xterm-256color', PAGER: 'less' });
    expect(env.TERM).toBe('dumb');
    expect(env.PAGER).toBe('cat');
    expect(env.GIT_PAGER).toBe('cat');
  });

  it('键名统一大写, 避免 Windows Path/PATH 重复', () => {
    const env = buildProcessEnvironment({ Path: 'C:\\bin', path: '/usr/bin' });
    expect(Object.keys(env).filter((k) => k === 'PATH')).toHaveLength(1);
  });
});
