import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
export function newId(prefix:string){return `${prefix}_${randomUUID()}`}
export function sign(value:string){const secret=process.env.APP_SECRET;if(!secret)throw new Error("APP_SECRET must be configured for approval actions.");return createHmac("sha256",secret).update(value).digest("hex")}
export function verify(value:string,signature:string){const expected=sign(value);try{return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"))}catch{return false}}

export function checkAdminAuth(req: Request): boolean {
  const configuredToken = process.env.ADMIN_TOKEN || "rr_admin_hackathon_2026_reliefready";
  const headerToken =
    req.headers.get("x-admin-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (!headerToken) return false;
  try {
    const bufA = Buffer.from(headerToken);
    const bufB = Buffer.from(configuredToken);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
