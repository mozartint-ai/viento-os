import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const tmpDir = path.join(root, "tmp", "social-agent");
const config = JSON.parse(await readFile(path.join(root, "config", "social-agent.json"), "utf8"));

const env = {
  bufferApiKey: process.env.BUFFER_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY,
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET,
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  assetType: String(process.env.SOCIAL_ASSET_TYPE || config.asset?.defaultType || "image").toLowerCase(),
  dryRun: String(process.env.SOCIAL_AGENT_DRY_RUN || "false").toLowerCase() === "true"
};

main().catch((error) => {
  console.error("Social agent failed:", error.message);
  process.exit(1);
});

async function main() {
  validateEnv();
  await mkdir(tmpDir, { recursive: true });

  const idea = await generateContentIdea();
  console.log("Generated content pillar:", idea.pillar);

  if (!["image", "video"].includes(env.assetType)) {
    throw new Error("SOCIAL_ASSET_TYPE must be image or video.");
  }

  const assetPath = path.join(tmpDir, `viento-${Date.now()}.${env.assetType === "video" ? "mp4" : "jpg"}`);
  if (env.assetType === "video") {
    await renderVideo(assetPath, idea);
    console.log("Video rendered:", assetPath);
  } else {
    await renderImage(assetPath, idea);
    console.log("Image rendered:", assetPath);
  }

  const mediaUrl = await uploadToCloudinary(assetPath, env.assetType);
  console.log("Cloudinary upload complete:", redactUrl(mediaUrl));

  const buffer = createBufferClient(env.bufferApiKey);
  const organization = await getPrimaryOrganization(buffer);
  const channels = await getTargetChannels(buffer, organization.id);

  if (channels.length === 0) {
    throw new Error("Buffer içinde Instagram veya TikTok kanalı bulunamadı. Buffer bağlantılarını kontrol et.");
  }

  console.log("Target channels:", channels.map((channel) => `${channel.service}:${channel.name}`).join(", "));

  const caption = buildCaption(idea);

  if (env.dryRun) {
    console.log("DRY RUN enabled. Buffer posts will not be created.");
    console.log("Caption preview:\n", caption);
    return;
  }

  let successCount = 0;
  for (const channel of channels) {
    try {
      const post = await createMediaPost(buffer, channel, caption, mediaUrl, env.assetType);
      successCount += 1;
      console.log(`Queued ${channel.service} post:`, post.id, post.dueAt || "next available slot");
    } catch (error) {
      console.warn(`Could not queue ${channel.service}: ${error.message}`);
    }
  }

  if (successCount === 0) {
    throw new Error("Hiçbir Buffer kanalına post eklenemedi.");
  }
}

function validateEnv() {
  const missing = [];
  for (const [name, value] of Object.entries({
    BUFFER_API_KEY: env.bufferApiKey,
    GEMINI_API_KEY: env.geminiApiKey,
    CLOUDINARY_CLOUD_NAME: env.cloudName,
    CLOUDINARY_API_KEY: env.cloudinaryApiKey,
    CLOUDINARY_API_SECRET: env.cloudinaryApiSecret
  })) {
    if (!value) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}

async function generateContentIdea() {
  const today = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "full",
    timeZone: "Europe/Istanbul"
  }).format(new Date());

  const prompt = `
You are the social media growth agent for ${config.brand.name}, a premium furniture/interior/exhibition stand brand since ${config.brand.since}.

Create one short vertical video concept for Instagram Reels and TikTok for ${today}.

Rules:
- Output valid JSON only.
- Turkish first, English secondary.
- No fake discounts, no fake client names, no unverifiable claims.
- Keep it premium and simple.
- The video will be a branded 8-second motion card, so provide short on-screen lines.

JSON schema:
{
  "pillar": "one content pillar",
  "hook_tr": "short Turkish hook",
  "hook_en": "short English hook",
  "caption_tr": "Turkish caption, max 550 chars",
  "caption_en": "English caption, max 350 chars",
  "video_lines": ["3 to 5 short Turkish lines"],
  "cta": "short Turkish call to action",
  "hashtags": ["8 to 12 relevant hashtags"]
}

Brand context:
${JSON.stringify(config, null, 2)}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.9,
        responseMimeType: "application/json"
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini API error: ${data.error?.message || response.statusText}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text).join("\n");
  if (!text) throw new Error("Gemini empty response");

  const parsed = JSON.parse(text);
  return {
    pillar: parsed.pillar || "custom interiors",
    hook_tr: parsed.hook_tr || "Mekânı karaktere dönüştüren detaylar",
    hook_en: parsed.hook_en || "Details that transform spaces",
    caption_tr: parsed.caption_tr || "Viento Art ile özel üretim mobilya ve iç mimari çözümler.",
    caption_en: parsed.caption_en || "Custom furniture and interior solutions by Viento Art.",
    video_lines: Array.isArray(parsed.video_lines) ? parsed.video_lines.slice(0, 5) : ["Viento Art", "Özel üretim mobilya", "2009'dan beri"],
    cta: parsed.cta || "Projeniz için bize ulaşın.",
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : config.posting.hashtags
  };
}

async function renderVideo(outputPath, idea) {
  const lines = [
    config.brand.name,
    ...idea.video_lines,
    idea.cta
  ].slice(0, 6);

  const textFile = path.join(tmpDir, "video-lines.txt");
  await writeFile(textFile, lines.join("\n\n"), "utf8");

  const duration = Number(config.video.durationSeconds || 8);
  const width = Number(config.video.width || 1080);
  const height = Number(config.video.height || 1920);

  const filter = [
    `scale=${width}:${height}`,
    "format=yuv420p",
    `drawbox=x=70:y=70:w=${width - 140}:h=${height - 140}:color=white@0.10:t=3`,
    `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile='${textFile}':fontcolor=white:fontsize=58:line_spacing=18:x=90:y=(h-text_h)/2:box=1:boxcolor=black@0.18:boxborderw=28`,
    "fade=t=in:st=0:d=0.6",
    `fade=t=out:st=${Math.max(1, duration - 0.8)}:d=0.8`
  ].join(",");

  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=0x101010:s=${width}x${height}:d=${duration}:r=30`,
    "-vf", filter,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  ]);
}

async function renderImage(outputPath, idea) {
  const width = Number(config.video.width || 1080);
  const height = Number(config.video.height || 1920);
  const svgPath = path.join(tmpDir, "visual-card.svg");
  await writeFile(svgPath, buildImageSvg(width, height, idea), "utf8");

  await run("ffmpeg", [
    "-y",
    "-i", svgPath,
    "-frames:v", "1",
    "-q:v", "2",
    outputPath
  ]);
}

function buildImageSvg(width, height, idea) {
  const palette = pickPalette();
  const safeHook = cleanText(idea.hook_tr, 72);
  const safeCaption = cleanText(idea.caption_tr, 135);
  const detailLines = (idea.video_lines || [])
    .map((line) => cleanText(line, 46))
    .filter(Boolean)
    .slice(0, 3);

  const eyebrow = `${config.brand.name} · Since ${config.brand.since}`;
  const title = safeHook || "Mekânı karaktere dönüştüren detaylar";
  const subtitle = safeCaption || "Özel üretim mobilya, iç mimari ve fuar standı çözümleri.";
  const cta = cleanText(idea.cta || "Projeniz için bize ulaşın.", 48);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${palette.bg1}"/>
      <stop offset="52%" stop-color="${palette.bg2}"/>
      <stop offset="100%" stop-color="${palette.bg3}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="18%" r="70%">
      <stop offset="0%" stop-color="${palette.glow}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${palette.glow}" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="24" stdDeviation="34" flood-color="#000000" flood-opacity="0.24"/>
    </filter>
  </defs>

  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <circle cx="930" cy="260" r="260" fill="${palette.accent}" opacity="0.10"/>
  <circle cx="120" cy="1600" r="360" fill="${palette.accent2}" opacity="0.10"/>

  <g opacity="0.16">
    <path d="M80 310 C280 235 465 260 635 190 S920 95 1030 150" fill="none" stroke="${palette.line}" stroke-width="2"/>
    <path d="M90 1560 C300 1485 520 1515 705 1435 S935 1330 1030 1380" fill="none" stroke="${palette.line}" stroke-width="2"/>
  </g>

  <rect x="70" y="86" width="${width - 140}" height="${height - 172}" rx="44" fill="${palette.card}" opacity="0.92" filter="url(#shadow)"/>
  <rect x="96" y="112" width="${width - 192}" height="${height - 224}" rx="34" fill="none" stroke="${palette.stroke}" stroke-width="2" opacity="0.65"/>

  <text x="130" y="190" fill="${palette.muted}" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" font-weight="600" letter-spacing="3">${escapeXml(eyebrow.toUpperCase())}</text>

  <g transform="translate(130 270)">
    <rect x="0" y="0" width="108" height="108" rx="28" fill="${palette.accent}"/>
    <text x="54" y="70" text-anchor="middle" fill="${palette.logoText}" font-family="DejaVu Sans, Arial, sans-serif" font-size="38" font-weight="800">VA</text>
  </g>

  ${svgTextBlock(title, 130, 485, 820, 66, 78, palette.text, 4, 800)}
  ${svgTextBlock(subtitle, 130, 800, 820, 38, 54, palette.text, 4, 500, 0.86)}

  <g transform="translate(130 1105)">
    ${detailLines.map((line, index) => `
    <g transform="translate(0 ${index * 126})">
      <circle cx="22" cy="25" r="8" fill="${palette.accent}"/>
      ${svgTextBlock(line, 58, 0, 730, 34, 48, palette.text, 2, 600, 0.92)}
    </g>`).join("")}
  </g>

  <g transform="translate(130 ${height - 260})">
    <rect x="0" y="0" width="820" height="108" rx="30" fill="${palette.accent}" opacity="0.96"/>
    <text x="42" y="68" fill="${palette.logoText}" font-family="DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="800">${escapeXml(cta)}</text>
  </g>

  <text x="130" y="${height - 92}" fill="${palette.muted}" font-family="DejaVu Sans, Arial, sans-serif" font-size="25" font-weight="500">vientoart.com</text>
</svg>`;
}

function pickPalette() {
  const palettes = [
    {
      bg1: "#F2EEE7",
      bg2: "#D8CBBB",
      bg3: "#A89078",
      card: "#FFFDF8",
      text: "#211B16",
      muted: "#746757",
      accent: "#7A4F31",
      accent2: "#C79B66",
      line: "#7A4F31",
      stroke: "#C6B49E",
      glow: "#FFFFFF",
      logoText: "#FFFFFF"
    },
    {
      bg1: "#101820",
      bg2: "#1F2A2E",
      bg3: "#6E604C",
      card: "#F7F1E8",
      text: "#151515",
      muted: "#6E6257",
      accent: "#9B6A3F",
      accent2: "#D8B98E",
      line: "#D8B98E",
      stroke: "#BFAE98",
      glow: "#D8B98E",
      logoText: "#FFFFFF"
    },
    {
      bg1: "#EFE7DD",
      bg2: "#C8B6A2",
      bg3: "#75624E",
      card: "#1E1B18",
      text: "#FFF8ED",
      muted: "#D7C7B3",
      accent: "#C59A62",
      accent2: "#FFFFFF",
      line: "#FFFFFF",
      stroke: "#C59A62",
      glow: "#FFFFFF",
      logoText: "#1E1B18"
    }
  ];
  const dayIndex = Math.floor(Date.now() / 86400000) % palettes.length;
  return palettes[dayIndex];
}

function svgTextBlock(text, x, y, maxWidth, fontSize, lineHeight, color, maxLines, weight = 500, opacity = 1) {
  const lines = wrapText(text, Math.max(10, Math.floor(maxWidth / (fontSize * 0.56))), maxLines);
  return `<text x="${x}" y="${y}" fill="${color}" opacity="${opacity}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}">${lines
    .map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join("")}</text>`;
}

function wrapText(text, maxChars, maxLines) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);

  if (lines.length === maxLines) {
    const consumed = lines.join(" ").length;
    if (String(text).length > consumed + 4) {
      lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,;:!?-]*$/, "")}…`;
    }
  }

  return lines.length ? lines : ["Viento Art"];
}

function cleanText(text, maxLength) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .replace(/\s+\S*$/, "");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function uploadToCloudinary(filePath, assetType) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = "viento-os/social-agent";
  const publicId = `viento-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;

  const signatureBase = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${env.cloudinaryApiSecret}`;
  const signature = crypto.createHash("sha1").update(signatureBase).digest("hex");

  const form = new FormData();
  form.append("file", new Blob([await readFile(filePath)], { type: assetType === "video" ? "video/mp4" : "image/jpeg" }), path.basename(filePath));
  form.append("api_key", env.cloudinaryApiKey);
  form.append("timestamp", timestamp);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("signature", signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudName}/${assetType}/upload`, {
    method: "POST",
    body: form
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Cloudinary upload error: ${data.error?.message || response.statusText}`);
  }
  return data.secure_url;
}

function createBufferClient(apiKey) {
  return async function bufferGraphql(query, variables = {}) {
    const response = await fetch("https://api.buffer.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, variables })
    });
    const data = await response.json();
    if (!response.ok || data.errors?.length) {
      throw new Error(`Buffer API error: ${data.errors?.[0]?.message || response.statusText}`);
    }
    return data.data;
  };
}

async function getPrimaryOrganization(buffer) {
  const data = await buffer(`
    query GetOrganizations {
      account {
        organizations {
          id
          name
          ownerEmail
        }
      }
    }
  `);
  const organization = data.account?.organizations?.[0];
  if (!organization) throw new Error("Buffer organization bulunamadı.");
  return organization;
}

async function getTargetChannels(buffer, organizationId) {
  const data = await buffer(`
    query GetChannels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId, filter: { isLocked: false } }) {
        id
        name
        displayName
        service
        isQueuePaused
      }
    }
  `, { organizationId });

  const targets = new Set(config.posting.targetServices);
  return (data.channels || []).filter((channel) => {
    const service = String(channel.service || "").toLowerCase();
    return targets.has(service) && !channel.isQueuePaused;
  });
}

async function createMediaPost(buffer, channel, text, mediaUrl, assetType) {
  const asset = assetType === "video"
    ? { video: { url: mediaUrl, metadata: { thumbnailOffset: 1500 } } }
    : { image: { url: mediaUrl } };

  const data = await buffer(`
    mutation CreateMediaPost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            text
            dueAt
            assets {
              id
              mimeType
            }
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `, {
    input: {
      text,
      channelId: channel.id,
      metadata: buildMetadata(channel, assetType),
      schedulingType: "automatic",
      mode: config.posting.defaultMode || "addToQueue",
      assets: [asset]
    }
  });

  const payload = data.createPost;
  if (payload?.message) throw new Error(`Buffer mutation error: ${payload.message}`);
  if (!payload?.post?.id) throw new Error("Buffer post oluşturuldu ama id dönmedi.");
  return payload.post;
}

function buildCaption(idea) {
  const hashtags = [...new Set([...(idea.hashtags || []), ...config.posting.hashtags])]
    .filter(Boolean)
    .slice(0, 14)
    .join(" ");

  return `${idea.hook_tr}\n\n${idea.caption_tr}\n\n${idea.caption_en}\n\n${idea.cta}\n\n${hashtags}`;
}

function buildMetadata(channel, assetType) {
  const service = String(channel.service || "").toLowerCase();

  if (service === "instagram") {
    return {
      instagram: {
        type: assetType === "video" ? "reel" : "post",
        shouldShareToFeed: true,
        isAiGenerated: true
      }
    };
  }

  if (service === "tiktok") {
    return {
      tiktok: {
        title: "Viento Art",
        isAiGenerated: assetType === "video"
      }
    };
  }

  return undefined;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/.../${path.basename(parsed.pathname)}`;
  } catch {
    return "(uploaded)";
  }
}
