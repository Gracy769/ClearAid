import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

let instance: PayPalAgentToolkit | null = null;
export function paypalTools(){
  const clientId=process.env.PAYPAL_CLIENT_ID, clientSecret=process.env.PAYPAL_CLIENT_SECRET;
  if(!clientId||!clientSecret) throw new Error("PayPal sandbox credentials are not configured.");
  if(!instance) instance=new PayPalAgentToolkit({clientId,clientSecret,configuration:{context:{sandbox:true},actions:{invoices:{create:true,get:true,send:true,list:true,search:true}}}});
  return instance.getTools();
}
export async function paypalCreateDraft(input:Record<string,unknown>){
  const tools=paypalTools(); const tool=tools.create_invoice;
  if(!tool)throw new Error("PayPal invoice creation tool is unavailable.");
  return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
}
export async function paypalSendInvoice(input:Record<string,unknown>){
  const tools=paypalTools(); const tool=tools.send_invoice;
  if(!tool)throw new Error("PayPal invoice sending tool is unavailable.");
  return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] } as never);
}
