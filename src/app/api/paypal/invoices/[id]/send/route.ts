import { NextRequest, NextResponse } from "next/server";
import { paypalTools } from "@/lib/paypal";
import { verify } from "@/lib/security";
import { reserveInvoiceSend, savePaypalInvoice } from "@/lib/db";
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){try{
 const {id}=await params;const {reviewId,sendToken}=await req.json() as {reviewId:string;sendToken:string};
 if(!id||!reviewId||!sendToken)return NextResponse.json({error:"Invoice and approval are required."},{status:400});
 const sendPayload=JSON.stringify({reviewId,invoiceId:id,action:"send"});if(!verify(sendPayload,sendToken))return NextResponse.json({error:"Send approval is invalid or stale."},{status:403});
 if(!await reserveInvoiceSend(id,reviewId))return NextResponse.json({error:"This invoice is not an unsent draft."},{status:409});
 const tool=paypalTools().send_invoice;if(!tool?.execute)throw Error("PayPal send tool unavailable.");
 try{const result=await tool.execute({invoice_id:id},{toolCallId:crypto.randomUUID(),messages:[]} as never);await savePaypalInvoice(id,reviewId,"SENT");
 return NextResponse.json({ok:true,result});
 }catch(error){await savePaypalInvoice(id,reviewId,"DRAFT");throw error}
}catch(e){console.error("PayPal send failed",e instanceof Error?e.message:"unknown");return NextResponse.json({error:e instanceof Error?e.message:"PayPal send failed."},{status:502})}}
