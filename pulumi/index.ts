import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

const stackName = pulumi.getStack();
const projectName = pulumi.getProject();
const publicIP = "123.123.123.123/32";
const cidrBlock = "10.0.0.0/16";

// ==================== NETWORKING ====================
const vpc = new awsx.ec2.Vpc(`${stackName}-vpc`, {
    cidrBlock: cidrBlock,
    numberOfAvailabilityZones: 3,
    subnets: [{ type: "public" }, { type: "private" }],
    tags: {
        "Name" : `${stackName}-vpc`,
        "Environment" : stackName
    }
});

// lookup exsisting vpc if AWS / AMC vendor already sets up the network...
//const exsistingVPC = aws.ec2.Vpc.get(`${stackName}-vpc`, "vpc-0579593528d2b3088");

// Web Security Group
const webSecurityGroup = new awsx.ec2.SecurityGroup(`${stackName}-doterra-web-access`, {
    vpc: vpc,
    tags: {
        "Environment" : stackName
    },
});

webSecurityGroup.createIngressRule(`${stackName}-https-access`, {
    location: { cidrBlocks: [publicIP] },
    ports: new awsx.ec2.TcpPorts(433)
});

webSecurityGroup.createIngressRule(`${stackName}-http-access`, {
    location: { cidrBlocks: [publicIP] },
    ports: new awsx.ec2.TcpPorts(80)
});

// ==================== (END) NETWORKING ====================


// ==================== EKS Cluster ====================
const cluster = new eks.Cluster(`${stackName}-k8s-cluster`, {
    vpcId: vpc.id,
    version: "1.21",
    subnetIds: vpc.publicSubnetIds,
    desiredCapacity: 2,
    minSize: 2,
    maxSize: 8,
    storageClasses: "gp2",
    deployDashboard: false,
    clusterSecurityGroup: webSecurityGroup.securityGroup,
    name: `${stackName}-k8-cluster`,
    tags: {
        "Environment" : stackName,
        "Project" : projectName
    }
});

const nodeSecurityGroup = cluster.nodeSecurityGroup;
export const nodesubnetIds = cluster.core.subnetIds;
export const clusterName = cluster.eksCluster.name;
export const kubeconfig = cluster.kubeconfig.apply(JSON.stringify);
// ==================== (END) EKS Cluster ====================


// ==================== AWS EFS ====================
// Create an EFS endpoint
export const efsFilesystem = new aws.efs.FileSystem(`${stackName}-${projectName}-efs`, {
    tags: { Name: `${stackName}-${projectName}-efs` }
  });
export const efsFilesystemId = efsFilesystem.id;
// Create a mounttarget in each of the EKS cluster VPC's AZs (3) so that EC2 instances across the VPC can access the filesystem
new aws.efs.MountTarget(`${stackName}-${projectName}-mount-target-1`, {
    fileSystemId: efsFilesystemId,
    securityGroups: [nodeSecurityGroup.id],
    subnetId: nodesubnetIds[0]
});
new aws.efs.MountTarget(`${stackName}-${projectName}-mount-target-2`, {
    fileSystemId: efsFilesystemId,
    securityGroups: [nodeSecurityGroup.id],
    subnetId: nodesubnetIds[1]
});
new aws.efs.MountTarget(`${stackName}-${projectName}-mount-target-3`, {
    fileSystemId: efsFilesystemId,
    securityGroups: [nodeSecurityGroup.id],
    subnetId: nodesubnetIds[2]
});

const efsAccessPointSecurityGroup = new awsx.ec2.SecurityGroup(`${stackName}-nfs-access-point`, {
    vpc: vpc,
    tags: {
        "Environment" : stackName,
        "Project" : projectName,
    },
});

efsAccessPointSecurityGroup.createIngressRule(`${stackName}-https-access`, {
    location: { cidrBlocks: [cidrBlock] }, // allow all internal IPs access
    ports: new awsx.ec2.TcpPorts(2049)
});
const efsAccessPoint = new aws.efs.AccessPoint(`${stackName}-k8s-efs-access-point`, 
    {
        fileSystemId: efsFilesystem.id,
        tags: {
            "Environment" : stackName,
            "Project" : projectName,
        }
    }
);
// ==================== (END) AWS EFS ====================

const ns = new k8s.core.v1.Namespace(`${stackName}-namespace`, {}, { provider: cluster.provider });
export const namespaceName = ns.metadata.apply(m => m.name);

// Create K8s Persistent Volume
const k8sPersistentVolume = new k8s.core.v1.PersistentVolume(`${stackName}-${projectName}-persistent-volume`, {
    spec: {
        storageClassName: "efs-sc",
        persistentVolumeReclaimPolicy: "Retain",
        capacity: {
            storage: "5Gi"
        },
        volumeMode: "FileSystem",
        csi: {
            driver: "efs.csi.aws.com",
            volumeHandle: efsFilesystem.
        }

    }
})

// Create a Jenkins Deployment
const appLabels = { appClass: `${stackName}-appclass` };
const deployment = new k8s.apps.v1.Deployment(`${stackName}-${projectName}-deployment`,
    {
        metadata: {
            namespace: namespaceName,
            labels: appLabels,
        },
        spec: {
            replicas: 1,
            selector: { matchLabels: appLabels },
            template: {
                metadata: {
                    labels: appLabels,
                },
                spec: {
                    containers: [
                        {
                            name: `${stackName}-jenkins`,
                            image: "jenkins/jenkins:lts",
                            
                            ports: [
                                { name: "http-port", containerPort: 8080 }
                            ],
                            volumeMounts: [
                                {
                                    name: efsAccessPoint.arn,
                                    mountPath: "/var/jenkins_home"
                                }
                            ]
                        }
                    ],
                    volumes: [
                        {
                            name: "persistent-storage",
                            persistentVolumeClaim: { 
                                claimName: "efs-claim" 
                            },
                            
                        }
                    ]
                }
            }
        },
    },
    {
        provider: cluster.provider,
    }
);

// Create a LoadBalancer Service for the Jenkins Server Deployment
const service = new k8s.core.v1.Service(`${stackName}-service`,
    {
        metadata: {
            labels: appLabels,
            namespace: namespaceName,
        },
        spec: {
            type: "LoadBalancer",
            ports: [{ port: 80, targetPort: 8080 }],
            selector: appLabels,
            loadBalancerSourceRanges: [publicIP] // Restrict access to only doTERRA
        },
    },
    {
        provider: cluster.provider,
    },
);

export const deploymentName = deployment.metadata.apply(m => m.name);
export const serviceName = service.metadata.apply(m => m.name);
export const serviceHostname = service.status.apply(s => s.loadBalancer.ingress[0].hostname);

export const vpcId = vpc.id;
export const vpcPrivateSubnetIds = vpc.privateSubnetIds;
export const vpcPublicSubnetIds = vpc.publicSubnetIds;
