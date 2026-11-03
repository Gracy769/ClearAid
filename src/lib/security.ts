import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
export function newId(prefix:string){return `${prefix}_${randomUUID()}`}
export function sign(value:string){const secret=process.env.APP_SECRET;if(!secret)throw new Error("APP_SECRET must be configured for approval actions.");return createHmac("sha256",secret).update(value).digest("hex")}
export function verify(value:string,signature:string){const expected=sign(value);try{return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(signature,"hex"))}catch{return false}}
