import { NextRequest, NextResponse } from "next/server";
import { paypalTools } from "@/lib/paypal";
import { sign, verify } from "@/lib/security";
export const runtime="nodejs";
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){try{
 const {id}=await params;const {reviewId,sendToken}=await req.json() as {reviewId:string;sendToken:string};
 if(!id||!reviewId||!sendToken)return NextResponse.json({error:"Invoice and approval are required."},{status:400});
 const sendApproval=sign(JSON.stringify({reviewId,invoiceId:id,action:"send"}));if(!verify(sendApproval,sendToken))return NextResponse.json({error:"Send approval is invalid or stale."},{status:403});
 const tool=paypalTools().send_invoice;if(!tool)throw Error("PayPal send tool unavailable.");
 const result=await tool.execute({invoice_id:id},{toolCallId:crypto.randomUUID(),messages:[]} as never);
 return NextResponse.json({ok:true,result});
}catch(e){console.error("PayPal send failed",e instanceof Error?e.message:"unknown");return NextResponse.json({error:e instanceof Error?e.message:"PayPal send failed."},{status:502})}}
