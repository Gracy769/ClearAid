import { NextRequest, NextResponse } from "next/server";
import { paypalCreateDraft } from "@/lib/paypal";
import { runPreflight } from "@/lib/preflight";
import { sign, verify } from "@/lib/security";
import type { ReviewResult } from "@/lib/types";
export const runtime="nodejs";
export async function POST(req:NextRequest){try{
 const {reviewId,approvalToken,review}=await req.json() as {reviewId:string;approvalToken:string;review:ReviewResult};
 if(!reviewId||!review||!approvalToken)return NextResponse.json({error:"A reviewed invoice and approval are required."},{status:400});
 const canonical=runPreflight(review.input);if(canonical.status!=="READY"||canonical.totalMinor!==review.totalMinor)return NextResponse.json({error:"Review is not ready or has changed. Run preflight again."},{status:409});
 const signed=sign(JSON.stringify({reviewId,reviewHash:sign(JSON.stringify(review))}));if(!verify(signed,approvalToken))return NextResponse.json({error:"Approval is invalid or stale. Run preflight again."},{status:403});
 const inv=review.input;const payload={detail:{currency_code:inv.currency,reference:inv.poNumber,note:`PO ${inv.poNumber}`},invoicer:{name:{given_name:inv.vendorName}},primary_recipients:[{billing_info:{name:{given_name:inv.buyerName},email_address:inv.buyerEmail}}],items:inv.items.map(item=>({name:item.description,quantity:item.quantity,unit_amount:{currency_code:inv.currency,value:item.unitAmount}})),configuration:{partial_payment:{allow_partial_payment:false}}};
 const result=await paypalCreateDraft(payload) as Record<string,unknown>;const id=String(result.id||result.invoice_id||"");if(!id)throw Error("PayPal did not return an invoice ID.");const links=Array.isArray(result.links)?result.links as {rel:string;href:string}[]:[];const url=links.find(x=>x.rel==="payer-view")?.href||"";
 const sendToken=sign(JSON.stringify({reviewId,invoiceId:id,action:"send"}));
 return NextResponse.json({id,url,status:result.status||"DRAFT",sendToken});
}catch(e){console.error("PayPal draft failed",e instanceof Error?e.message:"unknown");return NextResponse.json({error:e instanceof Error?e.message:"PayPal draft failed."},{status:502})}}
