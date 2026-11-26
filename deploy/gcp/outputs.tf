locals {
  public_ip = google_compute_instance.this.network_interface[0].access_config[0].nat_ip
  target    = "${var.ssh_user}@${local.public_ip}"
}

output "public_ip" {
  description = "Public IP address of the server."
  value       = local.public_ip
}

output "ssh_command" {
  description = "Connect to the server."
  value       = "ssh ${local.target}"
}

output "install_command" {
  description = "Next step: install mail-me on the server (run from your mail-me folder)."
  value       = "deploy/linux/install.sh ${local.target}"
}

output "push_config_command" {
  description = "Then: upload config.json, .env and sign-ins and start mail-me."
  value       = "deploy/linux/push-config.sh ${local.target}"
}
