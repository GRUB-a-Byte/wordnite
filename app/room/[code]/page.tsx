import { RoomView } from '@/components/RoomView';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  const { code } = await params;
  const sp = await searchParams;
  const seed = Number(first(sp.seed));
  const early = first(sp.early);
  return (
    <RoomView
      code={code.toUpperCase()}
      watch={first(sp.watch) === '1'}
      big={first(sp.big) === '1'}
      debug={first(sp.debug) === '1'}
      seed={Number.isFinite(seed) && first(sp.seed) !== undefined ? seed : undefined}
      earlyFinish={early === undefined ? undefined : early !== '0'}
    />
  );
}
