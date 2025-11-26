const ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'; // BTC/USD

export async function pythAtTimestamp(T) {
  const url = `https://hermes.pyth.network/v2/price_feeds?ids[]=${ID}&start_time=${T-120}&end_time=${T}&interval=1`;
  const r = await fetch(url); const j = await r.json();
  const pts = j?.price_feeds?.[0]?.price_series ?? j?.price_feeds?.[0]?.prices ?? [];
  if (!pts.length) throw new Error('no data in window');
  const last = [...pts].reverse().find(p => Number(p.publish_time) <= T) ?? pts[pts.length-1];
  const price = Number(last.price) * Math.pow(10, Number(last.expo));
  return { price, publishTime: Number(last.publish_time) };
}

pythAtTimestamp(1762967700000).then(res => console.log(res)).catch(console.error);
