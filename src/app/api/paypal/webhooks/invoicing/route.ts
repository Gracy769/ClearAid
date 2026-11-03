import { NextRequest,NextResponse } from "next/server";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 try{const event=await req.json();const webhookId=process.env.PAYPAL_WEBHOOK_ID;const clientId=process.env.PAYPAL_CLIENT_ID;const secret=process.env.PAYPAL_CLIENT_SECRET;
 if(!webhookId||!clientId||!secret)return NextResponse.json({error:"Webhook verification is not configured."},{status:503});
 const base="https://api-m.sandbox.paypal.com";const auth=Buffer.from(`${clientId}:${secret}`).toString("base64");const tokenRes=await fetch(`${base}/v1/oauth2/token`,{method:"POST",headers:{Authorization:`Basic ${auth},Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});
 if(!tokenRes.ok)throw Error("PayPal token request failed");const {access_token}=await tokenRes.json();
 const verification=await fetch(`${base}/v1/notifications/verify-webhook-signature`,{method:"POST",headers:{Authorization:`Bearer ${access_token}`,"Content-Type":"application/json"},body:JSON.stringify({auth_algo:req.headers.get("paypal-auth-algo"),cert_url:req.headers.get("paypal-cert-url"), transmission_id:req.headers.get("paypal-transmission-id"),transmission_sig:req.headers.get("paypal-transmission-sig"),transmission_time:req.headers.get("paypal-transmission-time"),webhook_id:webhookId,webhook_event:event})});
 const result=await verification.json();if(!verification.ok||result.verification_status!=="SUCCESS")return NextResponse.json({error:"Invalid webhook signature."},{status:401});
 return NextResponse.json({received:true,eventId:event.id,eventType:event.event_type});
 }catch(e){console.error("webhook handling failed",e instanceof Error?e.message:"unknown");return NextResponse.json({error:"Webhook verification failed."},{status:500})}
}
