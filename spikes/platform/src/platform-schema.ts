import {pgTable,text,timestamp} from 'drizzle-orm/pg-core';
export const bootProbe=pgTable('platform_boot_probe',{id:text('id').primaryKey(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow()});
import {apikey,organization,user} from './auth-schema';
export const apiKeyBinding=pgTable('platform_api_key_binding',{
  apiKeyId:text('api_key_id').primaryKey().references(()=>apikey.id,{onDelete:'cascade'}),
  tenantId:text('tenant_id').notNull().references(()=>organization.id,{onDelete:'cascade'}),
  userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
});
