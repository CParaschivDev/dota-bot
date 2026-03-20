const { PermissionsBitField } = require('discord.js');

function hasManagementAccess(member) {
  if (!member || member.permissions == null) {
    return false;
  }

  const permissions =
    member.permissions instanceof PermissionsBitField
      ? member.permissions
      : new PermissionsBitField(member.permissions);

  return (
    permissions.has(PermissionsBitField.Flags.Administrator) ||
    permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

module.exports = {
  hasManagementAccess,
};
