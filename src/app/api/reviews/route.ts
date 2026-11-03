import { NextRequest, NextResponse } from "next/server";
import { PDFParse } from "pdf-parse";
import { extractInvoiceTerms } from "@/lib/ai";
import { runPreflight } from "@/lib/preflight";
import { newId, sign } from "@/lib/security";
import type { ReviewInput } from "@/lib/types";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 try{
  const form=await req.formData(); const raw=String(form.get("data")||"{}"); const input=JSON.parse(raw) as ReviewInput;
  const file=form.get("file"); let text="";
  if(file instanceof File){if(file.type!=="application/pdf"||file.size>8*1024*1024)return NextResponse.json({error:"Upload a PDF no larger than 8 MB."},{status:400});const parser=new PDFParse({data:Buffer.from(await file.arrayBuffer())});try{text=(await parser.getText()).text.slice(0,24000)}finally{await parser.destroy()}}
  let aiUsed=false;
  if(text){const extracted=await extractInvoiceTerms(text);if(extracted){aiUsed=true;for(const key of ["vendorName","buyerName","buyerEmail","poNumber","currency","poCap"] as const){if(!input[key]&&extracted[key])input[key]=extracted[key] as never}if(input.items.length===1&&!input.items[0].description&&extracted.items?.length)input.items=extracted.items}}
  input.sourceText=text;
  const review=runPreflight(input);const reviewId=newId("rev");const token=sign(JSON.stringify({reviewId,reviewHash:sign(JSON.stringify(review))}));
  return NextResponse.json({reviewId,approvalToken:token,review,aiUsed});
 }catch(e){console.error("review failed",e instanceof Error?e.message:"unknown");return NextResponse.json({error:"Could not process this review. Try manual entry or a text-based PDF."},{status:422})}
}
