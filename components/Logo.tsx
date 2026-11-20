/** Original wordmark: a crown made of tiles. */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const text = size === 'lg' ? 'text-4xl sm:text-6xl' : size === 'md' ? 'text-2xl' : 'text-lg';
  const tile = size === 'lg' ? 'h-8 w-8 sm:h-11 sm:w-11 text-lg sm:text-2xl' : 'h-6 w-6 text-sm';
  return (
    <div className="flex items-center gap-3 select-none">
      <div className="flex items-end gap-1" aria-hidden>
        <span className={`${tile} grid place-items-center rounded-md bg-correct font-black text-white`}>W</span>
        <span className={`${tile} -translate-y-1.5 grid place-items-center rounded-md bg-royal font-black text-white`}>
          ♛
        </span>
        <span className={`${tile} grid place-items-center rounded-md bg-present font-black text-black`}>R</span>
      </div>
      <span className={`${text} font-black tracking-tight`}>
        WORD <span className="bg-gradient-to-r from-royal to-royal-2 bg-clip-text text-transparent">ROYALE</span>
      </span>
    </div>
  );
}
