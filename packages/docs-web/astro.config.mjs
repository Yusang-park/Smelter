import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://yusang-park.github.io/Smelter',
  integrations: [
    starlight({
      title: 'Smelter',
      favicon: '/favicon.png',
      logo: {
        src: './src/assets/logo.png',
        alt: 'Smelter',
      },
      description: 'AI workflow engine — package your coding workflows as YAML, run them anywhere.',
      head: [
        {
          tag: 'script',
          content: `if(!localStorage.getItem('smelter-theme-init')){localStorage.setItem('smelter-theme-init','1');localStorage.setItem('starlight-theme','dark');document.documentElement.dataset.theme='dark';}`,
        },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Yusang-park/Smelter' }],
      editLink: {
        baseUrl: 'https://github.com/Yusang-park/Smelter/edit/main/packages/docs-web/',
      },
      sidebar: [
        { label: '🗺️  Roadmap', link: '/roadmap/' },
        {
          label: 'The Book of Smelter',
          autogenerate: { directory: 'book' },
        },
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Guides',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Adapters',
          autogenerate: { directory: 'adapters' },
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deployment' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Contributing',
          autogenerate: { directory: 'contributing' },
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
});
