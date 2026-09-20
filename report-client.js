
async function reportOpportunity(opportunityId, orgId, reason, details) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return false;

    const { error } = await supabaseClient
      .from('reports')
      .insert([{
        opportunity_id: opportunityId,
        org_id: orgId,
        reporter_id: user.id,
        reason: reason,
        details: details || null
      }]);

    if (error) throw error;
    return true;
  } catch (err) {
    console.error('reportOpportunity failed:', err);
    return false;
  }
}
