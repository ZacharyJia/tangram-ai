export type ReleaseAsset = {
  name: string;
  url: string;
};

export type ReleaseInfo = {
  tag: string;
  assets: ReleaseAsset[];
};

const OWNER = "ZacharyJia";
const REPO = "tangram2";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}/releases`;

type GithubReleaseApi = {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
};

async function fetchRelease(url: string): Promise<GithubReleaseApi> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tangram2-upgrader",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub release request failed (${res.status}): ${body || res.statusText}`);
  }

  return (await res.json()) as GithubReleaseApi;
}

function normalizeRelease(item: GithubReleaseApi): ReleaseInfo {
  return {
    tag: item.tag_name,
    assets: item.assets.map((x) => ({
      name: x.name,
      url: x.browser_download_url,
    })),
  };
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const item = await fetchRelease(`${API_BASE}/latest`);
  return normalizeRelease(item);
}

export async function fetchReleaseByTag(tag: string): Promise<ReleaseInfo> {
  const cleanTag = tag.trim();
  const item = await fetchRelease(`${API_BASE}/tags/${encodeURIComponent(cleanTag)}`);
  return normalizeRelease(item);
}

