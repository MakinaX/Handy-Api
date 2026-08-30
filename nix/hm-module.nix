# Home-manager module for Handy API speech-to-text
#
# Provides a systemd user service for autostart.
# Usage: imports = [ handy-api.homeManagerModules.default ];
#        services.handy-api.enable = true;
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services."handy-api";
in
{
  options.services."handy-api" = {
    enable = lib.mkEnableOption "Handy API speech-to-text user service";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "handy-api.packages.\${system}.handy-api";
      description = "The Handy API package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services."handy-api" = {
      Unit = {
        Description = "Handy API speech-to-text";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${cfg.package}/bin/handy-api";
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
