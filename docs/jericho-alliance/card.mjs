import QR from "./qr.mjs";
const origin = "https://liberpict.com";
export function profileUrl(profile) {
  return `${origin}/jericho-alliance/id#${profile.japId ? "jap=" + profile.japId : "p=" + profile.profileRef}`;
}
async function atlas() {
  const img = new Image();
  img.src = "/jericho-alliance/assets/portraits.png";
  await img.decode();
  return img;
}
function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
async function save(c, name) {
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function portrait(ctx, image, profile, x, y, size) {
  const n = profile.avatar || 0,
    sw = image.width / 3,
    sh = image.height / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    image,
    (n % 3) * sw,
    Math.floor(n / 3) * sh,
    sw,
    sh,
    x,
    y,
    size,
    size,
  );
  const seed = profile.avatarSeed || "0123456789abcdef";
  for (let i = 0; i < 32; i++) {
    ctx.fillStyle =
      parseInt(seed[i % seed.length], 16) % 2 ? "#716083" : "#e3dac7";
    ctx.fillRect(x + (i * size) / 32, y + size - 12, size / 32 + 1, 12);
  }
}
export async function avatarDownload(profile) {
  const c = canvas(512, 512);
  portrait(c.getContext("2d"), await atlas(), profile, 0, 0, 512);
  await save(c, "Jericho-avatar.png");
}
export async function qrDownload(profile) {
  const c = canvas(1024, 1024);
  await QR.toCanvas(c, profileUrl(profile), {
    width: 1024,
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#172c29", light: "#ffffff" },
  });
  await save(c, "Jericho-profile-QR.png");
}
function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
function fit(ctx, text, maxWidth, size, family = "Georgia") {
  while (size > 22) {
    ctx.font = `${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
}
function wrap(ctx, text, x, y, width, lineHeight) {
  let row = "";
  for (const word of text.split(" ")) {
    if (ctx.measureText(row + word).width > width && row) {
      ctx.fillText(row.trim(), x, y);
      y += lineHeight;
      row = "";
    }
    row += word + " ";
  }
  ctx.fillText(row.trim(), x, y);
  return y + lineHeight;
}
export async function cardDownload(profile, side) {
  const c = canvas(1712, 1080),
    ctx = c.getContext("2d");
  ctx.fillStyle = "#f6f3eb";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#716083";
  ctx.lineWidth = 3;
  ctx.strokeRect(42, 42, 1628, 996);
  ctx.strokeRect(56, 56, 1600, 968);
  ctx.fillStyle = "#172c29";
  ctx.textAlign = "center";
  ctx.font = "44px Georgia";
  ctx.fillText("JERICHO ALLIANCE", 856, 130);
  line(ctx, 95, 165, 1617, 165);
  if (side === "front") {
    portrait(ctx, await atlas(), profile, 105, 235, 450);
    ctx.textAlign = "left";
    ctx.font = "24px Arial";
    ctx.fillStyle = "#716083";
    ctx.fillText("DISPLAY NAME", 620, 265);
    ctx.fillStyle = "#172c29";
    fit(ctx, profile.displayName, 970, 74);
    ctx.fillText(profile.displayName, 620, 370);
    ctx.font = "33px Georgia";
    ctx.fillText(profile.community, 620, 440);
    ctx.font = "25px Arial";
    ctx.fillStyle = "#ad3f29";
    ctx.fillText(
      profile.status === "verified"
        ? "DOCUMENT CHECK COMPLETED"
        : "SELF-DECLARED · IDENTITY NOT VERIFIED",
      620,
      535,
    );
    ctx.fillStyle = "#172c29";
    ctx.font = "28px monospace";
    ctx.fillText(profile.japId || "JAP NUMBER AWAITING VERIFICATION", 620, 605);
    ctx.font = "22px Arial";
    ctx.fillText("PICT / Jericho channel", 620, 660);
    line(ctx, 95, 750, 1617, 750);
    ctx.textAlign = "center";
    ctx.font = "30px Georgia";
    ctx.fillText("PRIVATE COMMUNITY PROFILE", 856, 820);
    ctx.font = "22px Arial";
    ctx.fillText(
      "Community membership only · Not a government ID or travel document",
      856,
      880,
    );
    ctx.font = "20px Arial";
    ctx.fillText(
      `Saved ${new Date(profile.updatedAt).toISOString().slice(0, 10)}${profile.expiresAt ? " · Check valid through " + new Date(profile.expiresAt).toISOString().slice(0, 10) : ""}`,
      856,
      930,
    );
  } else {
    const qr = canvas(540, 540);
    await QR.toCanvas(qr, profileUrl(profile), {
      width: 540,
      margin: 4,
      errorCorrectionLevel: "M",
    });
    ctx.drawImage(qr, 95, 225);
    ctx.textAlign = "left";
    ctx.font = "47px Georgia";
    ctx.fillText("Check the current record.", 700, 280);
    ctx.font = "28px Arial";
    wrap(
      ctx,
      "Scan to open the issuer’s live status. A saved image may be out of date. Public details follow the member’s visibility settings.",
      700,
      350,
      850,
      42,
    );
    ctx.font = "25px Arial";
    wrap(
      ctx,
      "Private information requires an active access pass and the named recipient’s confirmed account.",
      700,
      560,
      850,
      39,
    );
    ctx.font = "25px Arial";
    wrap(
      ctx,
      "The avatar is chosen artwork. Display name and community are self-declared. This card does not establish citizenship, immigration status, or travel eligibility.",
      700,
      700,
      850,
      38,
    );
    line(ctx, 95, 890, 1617, 890);
    ctx.textAlign = "center";
    ctx.font = "24px Arial";
    ctx.fillText("liberpict.com/jericho-alliance/id", 856, 950);
  }
  await save(c, `Jericho-card-${side}.png`);
}
