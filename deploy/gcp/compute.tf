locals {
  default_zones = {
    us-west1    = "us-west1-b"
    us-central1 = "us-central1-a"
    us-east1    = "us-east1-b" # us-east1 has no zone "a"
  }
  zone = var.zone != "" ? var.zone : local.default_zones[var.region]
}

resource "google_compute_instance" "this" {
  name   = var.display_name
  zone   = local.zone
  labels = local.labels
  tags   = [local.tag]

  # The free tier covers one e2-micro. Not a variable on purpose: anything bigger is billed.
  machine_type              = "e2-micro"
  allow_stopping_for_update = true

  boot_disk {
    auto_delete = true
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_size_gb
      # Only "standard" disks are free; the console's default "balanced" disk is billed.
      type   = "pd-standard"
      labels = local.labels
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.this.id
    # An ephemeral public IP. The free tier does not charge for it on the free e2-micro.
    access_config {}
  }

  metadata = {
    ssh-keys               = "${var.ssh_user}:${trimspace(var.ssh_public_key)}"
    block-project-ssh-keys = "true"
    enable-oslogin         = "FALSE"
  }

  scheduling {
    preemptible        = false
    automatic_restart  = true
    provisioning_model = "STANDARD"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    # The image family moves to newer images over time. Without this, a later apply would
    # replace the server and lose data/.
    ignore_changes = [boot_disk[0].initialize_params[0].image]

    precondition {
      condition     = startswith(local.zone, "${var.region}-")
      error_message = "zone ${local.zone} is not in region ${var.region}."
    }
  }
}
