const ADJECTIVES = [
  "friendly", "cosmic", "swift", "gentle", "bold", "clever", "bright",
  "calm", "happy", "brave", "quiet", "wild", "warm", "cool", "wise",
  "noble", "eager", "lucky", "merry", "vivid", "azure", "coral",
  "golden", "silver", "amber", "crimson", "jade", "violet", "rustic",
  "lively", "daring", "witty", "sleek", "rapid", "steady", "keen",
  "fierce", "serene", "jolly", "plucky", "nimble", "peppy", "breezy",
];

const ANIMALS = [
  "lizard", "panda", "falcon", "fox", "owl", "dolphin", "wolf",
  "tiger", "hawk", "bear", "rabbit", "otter", "raven", "lynx",
  "eagle", "koala", "badger", "crane", "heron", "swan", "jaguar",
  "gazelle", "phoenix", "sparrow", "turtle", "bison", "panther",
  "coyote", "finch", "osprey", "mongoose", "marten", "penguin",
  "toucan", "ibis", "condor", "stork", "oriole", "wombat", "lemur",
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function friendlyName(visitorId: string): string {
  const h = hashStr(visitorId);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const animal = ANIMALS[(h >> 8) % ANIMALS.length];
  return `${adj} ${animal}`;
}
