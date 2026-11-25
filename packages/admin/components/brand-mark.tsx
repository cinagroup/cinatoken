import Image from 'next/image';

/** Shared, decorative brand symbol; adjacent translated text names the product. */
export default function BrandMark({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <Image
      src="/web-assets/cinagroup-logo.31da4b7fb36b.png"
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      className={`shrink-0 ${className}`}
      loading="eager"
      draggable={false}
      unoptimized
    />
  );
}
