export default function FrontendAttribution({ compact = false }: { compact?: boolean }) {
  return (
    <p className={compact ? 'text-[10px] leading-4' : 'text-xs leading-5'}>
      Frontend design and development by New API contributors.{' '}
      <a
        href="https://github.com/QuantumNous/new-api"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-cyan-600"
      >
        Original project
      </a>
    </p>
  );
}
